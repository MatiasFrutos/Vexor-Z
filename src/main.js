import '@xterm/xterm/css/xterm.css';
import './style.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { SerializeAddon } from '@xterm/addon-serialize';
import { createTransport } from './transport.js';
import { themes } from './themes.js';
import { loadConfig, getConfig, saveConfig } from './config.js';
import { h, icon, toast, showMenu } from './ui.js';
import { initSidePanel } from './sidepanel.js';
import { initSettings } from './settings.js';
import { initAiBar } from './aibar.js';
import { ACTIONS, comboFromEvent, buildBindings, labelOf } from './keys.js';
import { askInput, confirmBox } from './dialogs.js';
import { createVi } from './vimode.js';
import { createHints } from './hints.js';
import { createHistory } from './history.js';
import { initBackground } from './background.js';
import { attachShellIntegration, jumpPrompt, fmtDuration, lastOutput } from './shellint.js';

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

let transport, panel, settings, aibar, vi, hints, background, hist;
const panes = new Map();
let tabs = []; // pestañas del espacio de trabajo activo
let workspaces = [], curWs = null, wsSeq = 0;
const WS_COLORS = ['#7c8cff', '#5ec4d4', '#5fc08a', '#e0a951', '#ec6a75', '#c49bff', '#ff9d6e'];
let activeTab = null;
let nextId = 1, aiSeq = 0;
let broadcast = false;
let sys = null;
const sysHist = { cpu: [], rx: 0, tx: 0, prev: null };
let sshHosts = [];
let bindings = new Map();
let viActive = false;

/* ───────── Configuración / tema / aspecto ───────── */
const tinted = () => getConfig().bg.mode !== 'none' || getConfig().opacity < 0.999;

function termTheme() {
  const c = getConfig();
  const t = (themes[c.theme] ?? themes['Vexor Night']).term;
  return tinted() ? { ...t, background: '#00000000' } : t; // con fondo/transparencia, el tinte lo pone el CSS del panel
}

function termOptions() {
  const c = getConfig();
  return {
    fontFamily: c.font.family, fontSize: c.font.size, lineHeight: c.font.lineHeight, letterSpacing: c.font.letterSpacing,
    fontWeight: c.font.weight, fontWeightBold: c.font.boldWeight,
    cursorBlink: c.cursor.blink, cursorStyle: c.cursor.style, cursorWidth: 2, scrollback: c.scrollback, scrollSensitivity: c.scrollSensitivity,
    allowProposedApi: true, allowTransparency: tinted(), macOptionIsMeta: true, theme: termTheme(),
    linkHandler: { activate: (e, uri) => { if (e.ctrlKey || e.metaKey) openLink(uri); }, allowNonHttpProtocols: false },
  };
}

function applyConfig() {
  const c = getConfig();
  if (!themes[c.theme]) c.theme = 'Vexor Night';
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(themes[c.theme].ui)) root.setProperty(`--${k}`, v);
  root.setProperty('--chrome-alpha', String(c.opacity));
  root.setProperty('--ui-scale', String(c.ui.scale));
  document.body.classList.toggle('hud', c.ui.style !== 'clean');
  document.body.classList.toggle('glow', !!c.ui.glow);
  applyTabsPosition();
  root.setProperty('--term-alpha', String((c.bg.mode !== 'none' ? c.bg.dim : 1) * c.opacity));
  const o = termOptions();
  panes.forEach((p) => { for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'fontWeightBold', 'cursorBlink', 'cursorStyle', 'scrollback', 'scrollSensitivity', 'allowTransparency', 'theme']) { if (p.term.options[k] !== o[k]) p.term.options[k] = o[k]; } });
  bindings = buildBindings(c.keys);
  background?.apply();
  scheduleFit();
  updateStatus();
}

let fitRaf = 0;
function scheduleFit() { if (!fitRaf) fitRaf = requestAnimationFrame(() => { fitRaf = 0; fitAll(); }); }

/* ───────── Utilidades ───────── */
async function copyText(t, quiet) {
  try { await navigator.clipboard.writeText(t); if (!quiet) toast('Copiado'); } catch { toast('No se pudo acceder al portapapeles', 'error'); }
}
async function smartPaste(p, txt) {
  const lines = txt.replace(/\n$/, '').split('\n').length;
  if (getConfig().confirmPaste && lines > 1 && !p.term.modes.bracketedPasteMode) {
    if (!(await confirmBox({ title: 'Pegar varias líneas', message: `Vas a pegar ${lines} líneas y el shell las ejecutará. ¿Continuar?`, okLabel: 'Pegar' }))) return focusPane(p);
  }
  p.term.paste(txt);
  focusPane(p);
}
async function pasteInto(p) {
  try { smartPaste(p, await navigator.clipboard.readText()); } catch { toast('No se pudo leer el portapapeles', 'error'); }
}
function openLink(uri) { transport.openUrl(uri).catch((e) => toast(String(e?.message || e), 'error')); }
function notify(title, body) {
  transport.notify(title, body);
  if (document.hasFocus()) toast(`${title}${body ? ` — ${body}` : ''}`);
}

/* ───────── Paneles ───────── */
function createPane(cwd) {
  const id = nextId++;
  const el = document.createElement('div');
  el.className = 'pane';
  const term = new Terminal(termOptions());
  const fit = new FitAddon(), search = new SearchAddon(), serialize = new SerializeAddon();
  term.loadAddon(fit); term.loadAddon(search); term.loadAddon(serialize);
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
  // OSC 52: los programas pueden copiar al portapapeles, pero nunca leerlo.
  term.loadAddon(new ClipboardAddon(undefined, { readText: async () => '', writeText: async (_s, text) => { copyText(text, true); } }));
  term.loadAddon(new WebLinksAddon((e, uri) => { if (e.ctrlKey || e.metaKey) openLink(uri); }));
  const pane = { id, el, term, fit, search, serialize, title: 'shell', cwd: cwd || null, initCwd: cwd || null, git: null, fg: null, tab: null, started: false, mounted: false, q: [], flushT: 0 };
  pane.ready = new Promise((r) => (pane.resolveReady = r));
  panes.set(id, pane);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') { copyText(term.getSelection(), true); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { pasteInto(pane); return false; }
    return !e.defaultPrevented; // los atajos de la app ya se gestionaron en la fase de captura
  });
  term.onData((d) => {
    if (broadcast && pane.tab) leaves(pane.tab.root).forEach((q) => q.started && transport.write(q.id, d));
    else transport.write(id, d);
  });
  term.onResize(({ cols, rows }) => { transport.resize(id, cols, rows); updateStatus(); });
  term.onTitleChange((t) => { pane.title = t || 'shell'; renderTabs(); updateStatus(); });
  term.onBell(() => {
    const t = pane.tab;
    if (getConfig().bell && t && t !== activeTab && !t.bell) { t.bell = true; renderTabs(); renderWsSwitcher(); }
    if (getConfig().bellFlash && t === activeTab) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 400); }
  });
  term.onSelectionChange(() => { if (getConfig().copyOnSelect && !viActive) { const s = term.getSelection(); if (s) copyText(s, true); } });
  search.onDidChangeResults?.((r) => { if (pane === activeTab?.focus) setFindCount(r); });
  attachShellIntegration(pane, { notify, onCommandDone });
  el.addEventListener('mousedown', () => focusPane(pane));
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); focusPane(pane); paneMenu(e.clientX, e.clientY, pane); });
  return pane;
}

// xterm debe abrirse con el elemento ya dentro del DOM (si no, mide mal y no pinta).
function mountPane(p) {
  if (p.mounted) return;
  p.mounted = true;
  p.term.open(p.el);
  try { p.term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, sixelScrolling: true })); } catch {}
  p.term.textarea?.addEventListener('paste', (e) => {
    const txt = e.clipboardData?.getData('text') ?? '';
    if (txt.replace(/\n$/, '').includes('\n') && getConfig().confirmPaste && !p.term.modes.bracketedPasteMode) { e.preventDefault(); e.stopImmediatePropagation(); smartPaste(p, txt); }
  }, true);
  if (new URLSearchParams(location.search).get('renderer') === 'dom') return;
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    p.term.loadAddon(gl);
  } catch { /* fallback al renderer DOM */ }
}

function fitPane(p) {
  if (!p.mounted || !p.el.isConnected || p.el.clientWidth === 0) return;
  try { p.fit.fit(); } catch {}
}

function startPane(p) {
  if (p.started) return;
  mountPane(p);
  fitPane(p);
  p.started = true;
  transport.spawn(p.id, p.term.cols || 80, p.term.rows || 24, p.initCwd);
}

async function runInPane(p, cmd) {
  await p.ready;
  await sleep(150);
  transport.write(p.id, cmd + '\r');
}

// La salida grande del PTY se agrupa y se escribe una vez por fotograma (mucho más fluido con salidas enormes).
function onPtyData(id, data) {
  const p = panes.get(id); if (!p) return;
  p.resolveReady?.();
  // Eco de teclado y salida pequeña: se escribe al instante (mínima latencia); lo grande se agrupa por fotograma.
  if (!p.flushT && data.length < 1024) { p.term.write(data); return; }
  p.q.push(data);
  if (p.flushT) return;
  const flush = () => {
    cancelAnimationFrame(p.raf); clearTimeout(p.tm); p.flushT = 0;
    if (!panes.has(p.id) || !p.q.length) return;
    const s = p.q.join(''); p.q.length = 0;
    p.term.write(s);
  };
  p.flushT = 1;
  p.raf = requestAnimationFrame(flush);
  p.tm = setTimeout(flush, 40); // respaldo si la ventana está oculta (no hay rAF)
}

function onCommandDone(p) {
  p.gitStale = true; // un comando pudo cambiar la rama o los archivos
  const n = getConfig().notifyAfter;
  const away = !document.hasFocus() || p.tab !== activeTab;
  if (n > 0 && p.last.dur >= n && away) {
    notify(p.last.exit === 0 ? 'Comando terminado' : `Comando falló (código ${p.last.exit})`, `${fmtDuration(p.last.dur)}${p.cwd ? ` · ${p.cwd}` : ''}`);
    if (p.tab && p.tab !== activeTab && !p.tab.bell) { p.tab.bell = true; renderTabs(); renderWsSwitcher(); }
  }
  if (p === activeTab?.focus) updateStatus();
}

/* ───────── Árbol de splits ───────── */
// nodo: { pane } | { dir:'row'|'col', a, b, ratio }
function leaves(n, out = []) { if (n.pane) out.push(n.pane); else { leaves(n.a, out); leaves(n.b, out); } return out; }
function findParent(root, pane, parent = null) {
  if (root.pane) return root.pane === pane ? { node: root, parent } : null;
  return findParent(root.a, pane, root) || findParent(root.b, pane, root);
}
function findParentOfNode(root, target) {
  if (root.pane) return null;
  if (root.a === target || root.b === target) return root;
  return findParentOfNode(root.a, target) || findParentOfNode(root.b, target);
}
function equalize(n) { if (!n.pane) { n.ratio = 0.5; equalize(n.a); equalize(n.b); } }

function buildDom(n, tab) {
  if (n.pane) { n.pane.tab = tab; n.pane.el.style.flex = ''; return n.pane.el; }
  const wrap = document.createElement('div');
  wrap.className = 'split' + (n.dir === 'col' ? ' col' : '');
  const a = buildDom(n.a, tab), b = buildDom(n.b, tab);
  a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0`;
  const g = document.createElement('div'); g.className = 'gutter';
  g.addEventListener('mousedown', (ev) => dragGutter(ev, n, wrap, a, b, g));
  wrap.append(a, g, b);
  return wrap;
}

function dragGutter(ev, n, wrap, a, b, g) {
  ev.preventDefault(); g.classList.add('drag');
  const rect = wrap.getBoundingClientRect(), col = n.dir === 'col';
  const move = (e) => {
    const r = col ? (e.clientY - rect.top) / rect.height : (e.clientX - rect.left) / rect.width;
    n.ratio = Math.min(0.9, Math.max(0.1, r));
    a.style.flex = `${n.ratio} 1 0`; b.style.flex = `${1 - n.ratio} 1 0`;
    scheduleFit();
  };
  const up = () => { g.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); scheduleSave(); };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
}

function renderTab(tab) {
  const ls = leaves(tab.root);
  if (tab.zoom && !ls.includes(tab.zoom)) tab.zoom = null;
  if (tab.zoom) { tab.zoom.tab = tab; tab.zoom.el.style.flex = ''; tab.view.replaceChildren(tab.zoom.el); }
  else tab.view.replaceChildren(buildDom(tab.root, tab));
  ls.forEach((p) => p.el.classList.toggle('multi', ls.length > 1 && !tab.zoom));
  scheduleFit();
}

const ensureStarted = (tab) => leaves(tab.root).forEach((p) => startPane(p));

/* ───────── Pestañas ───────── */
const inheritedCwd = () => (getConfig().inheritCwd ? activeTab?.focus?.cwd || null : null);

function makeTab(root, name, focus) {
  const view = document.createElement('div'); view.className = 'tabview';
  $('#stage').append(view);
  const tab = { root, view, focus, name: name || null, zoom: null, bell: false, ws: curWs };
  tabs.push(tab);
  return tab;
}

function newTab(opts = {}) {
  const pane = createPane(opts.cwd !== undefined ? opts.cwd : inheritedCwd());
  const tab = makeTab({ pane }, null, pane);
  selectTab(tab);
  return tab;
}

function selectTab(tab) {
  activeTab = tab; tab.bell = false; renderWsSwitcher();
  $('#stage').querySelectorAll('.tabview').forEach((v) => v.classList.toggle('active', v === tab.view));
  curWs.active = tab;
  renderTab(tab);
  syncTabClasses();
  requestAnimationFrame(() => { ensureStarted(tab); focusPane(tab.focus); });
  focusPane(tab.focus);
  syncActions();
  scheduleSave();
}

function closeTab(tab) {
  const ws = tab.ws || curWs;
  leaves(tab.root).forEach(destroyPane);
  tab.view.remove();
  const i = ws.tabs.indexOf(tab); if (i >= 0) ws.tabs.splice(i, 1);
  if (ws !== curWs) { // la pestaña era de otro espacio de trabajo (p. ej. terminó su proceso en segundo plano)
    if (ws.active === tab) ws.active = ws.tabs[0] || null;
    if (!ws.tabs.length && workspaces.length > 1) workspaces.splice(workspaces.indexOf(ws), 1);
    renderWsSwitcher(); scheduleSave(); return;
  }
  if (!tabs.length) {
    if (workspaces.length > 1) return dropWorkspace(curWs);
    transport.closeWindow(); if (transport.kind === 'web') newTab({ cwd: null }); return;
  }
  if (activeTab === tab) selectTab(tabs[Math.max(0, i - 1)]); else { renderTabs(); scheduleSave(); }
}

function destroyPane(p) {
  clearTimeout(p.tm); cancelAnimationFrame(p.raf);
  if (p.started) transport.kill(p.id);
  panes.delete(p.id);
  try { p.term.dispose(); } catch {}
  p.el.remove();
}

/** Pide confirmación si alguno de los paneles tiene un proceso en primer plano. */
async function confirmBusy(list, what) {
  if (!getConfig().confirmClose) return true;
  for (const p of list) {
    if (!p.started) continue;
    const fg = await transport.fg(p.id);
    if (fg) return confirmBox({ title: `Cerrar ${what}`, message: `Hay un proceso en ejecución (${fg}). Si cierras, se terminará. ¿Cerrar ${what}?`, okLabel: 'Cerrar' });
  }
  return true;
}
async function requestClosePane(p = activeTab.focus) {
  const tab = p.tab || activeTab;
  if (leaves(tab.root).length === 1) return requestCloseTab(tab);
  if (await confirmBusy([p], 'el panel')) closePane(p); else focusPane(p);
}
async function requestCloseTab(tab) {
  if (await confirmBusy(leaves(tab.root), 'la pestaña')) closeTab(tab); else focusPane(activeTab?.focus);
}

// Cambiar de pestaña solo actualiza clases (sin reconstruir el DOM), así el doble clic para renombrar funciona.
function syncTabClasses() {
  if ($('#tabs').children.length !== tabs.length) return renderTabs();
  tabs.forEach((t, i) => {
    const el = $('#tabs').children[i];
    el.classList.toggle('active', t === activeTab);
    if (!t.bell) el.querySelector('.dot')?.remove();
  });
}

const base = (p) => (p === '/' ? '/' : p.split('/').filter(Boolean).pop());
const tabLabel = (t) => {
  if (t.name) return t.name;
  const f = t.focus; if (!f) return 'shell';
  const where = f.cwd ? base(f.cwd) : f.title;
  return f.fg ? `${where} · ${f.fg}` : where || 'shell';
};
let dragIdx = -1;

function renderTabs() {
  const box = $('#tabs'); box.replaceChildren();
  tabs.forEach((t, i) => {
    const name = h('span', { class: 'name', title: 'Doble clic para renombrar' }, tabLabel(t));
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); renameTab(t, name); });
    const el = h('div', { class: 'tab' + (t === activeTab ? ' active' : ''), draggable: 'true', title: t.focus?.cwd || '', onclick: () => t !== activeTab && selectTab(t), onauxclick: (e) => e.button === 1 && requestCloseTab(t) },
      icon('terminal', 13), name, t.bell ? h('span', { class: 'dot', title: 'Aviso' }) : null,
      h('button', { class: 'x', title: 'Cerrar pestaña', onclick: (e) => { e.stopPropagation(); requestCloseTab(t); } }, icon('x', 12)));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(e.clientX, e.clientY, t); });
    el.addEventListener('dragstart', (e) => { dragIdx = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); });
    el.addEventListener('dragover', (e) => { if (dragIdx >= 0 && dragIdx !== i) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.classList.remove('drop');
      if (dragIdx >= 0 && dragIdx !== i) moveTab(dragIdx, i);
      dragIdx = -1;
    });
    el.addEventListener('dragend', () => { dragIdx = -1; });
    box.append(el);
  });
}

function moveTab(from, to) {
  if (to < 0 || to >= tabs.length || from === to) return;
  const [m] = tabs.splice(from, 1); tabs.splice(to, 0, m);
  renderTabs(); scheduleSave();
}

function renameTab(tab, nameEl) {
  const input = h('input', { class: 'name-input', value: tab.name || tabLabel(tab) });
  nameEl.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = (ok) => { if (done) return; done = true; if (ok) tab.name = input.value.trim() || null; renderTabs(); scheduleSave(); focusPane(tab.focus); };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ───────── Sesión y layouts ───────── */
let saveTimer = 0;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSession, 700); }
const serializeNode = (n) => (n.pane ? { cwd: n.pane.cwd } : { dir: n.dir, ratio: n.ratio, a: serializeNode(n.a), b: serializeNode(n.b) });
const wsSnapshot = (ws) => ({ active: Math.max(0, ws.tabs.indexOf(ws.active)), tabs: ws.tabs.map((t) => ({ name: t.name, root: serializeNode(t.root), focus: Math.max(0, leaves(t.root).indexOf(t.focus)) })) });
const snapshot = () => wsSnapshot(curWs); // para los layouts: el espacio de trabajo actual
function saveSession() {
  if (!getConfig().restoreSession || !workspaces.some((w) => w.tabs.length)) return;
  saveConfig({ session: { active: Math.max(0, workspaces.indexOf(curWs)), workspaces: workspaces.filter((w) => w.tabs.length).map((w) => ({ name: w.name, color: w.color, ...wsSnapshot(w) })) } });
}
function fromSaved(n) {
  if (n && n.dir && n.a && n.b) return { dir: n.dir === 'col' ? 'col' : 'row', ratio: Math.min(0.9, Math.max(0.1, Number(n.ratio) || 0.5)), a: fromSaved(n.a), b: fromSaved(n.b) };
  return { pane: createPane(n?.cwd || null) };
}
function restoreTabs(s, { append = false } = {}) {
  if (!Array.isArray(s?.tabs) || !s.tabs.length) return false;
  const first = tabs.length;
  for (const st of s.tabs) { const root = fromSaved(st.root); const ls = leaves(root); makeTab(root, st.name, ls[st.focus] || ls[0]); }
  curWs.active = tabs[append ? first : Math.min(Math.max(s.active | 0, 0), tabs.length - 1)];
  if (append) selectTab(curWs.active);
  return true;
}
/** Restaura la sesión guardada (formato nuevo con espacios de trabajo o el antiguo, solo pestañas). */
function restoreSession(s) {
  const list = Array.isArray(s?.workspaces) ? s.workspaces : Array.isArray(s?.tabs) ? [{ name: 'Principal', ...s }] : [];
  if (!list.some((w) => w.tabs?.length)) return false;
  workspaces = []; wsSeq = 0;
  for (const w of list.filter((x) => x.tabs?.length)) {
    const ws = mkWs(w.name || 'Espacio', w.color);
    workspaces.push(ws); curWs = ws; tabs = ws.tabs;
    restoreTabs(w);
  }
  const target = workspaces[Math.min(Math.max((s.active | 0), 0), workspaces.length - 1)];
  curWs = null; switchWorkspace(target);
  return true;
}
addEventListener('beforeunload', saveSession);

async function saveLayout() {
  const name = await askInput({ title: 'Guardar layout actual', placeholder: 'Nombre del layout (p. ej. “Desarrollo”)', okLabel: 'Guardar' });
  if (!name) return focusPane(activeTab.focus);
  await saveConfig({ layouts: { [name]: snapshot() } });
  toast(`Layout “${name}” guardado`); focusPane(activeTab.focus);
}
const layoutNames = () => Object.entries(getConfig().layouts || {}).filter(([, v]) => v && v.tabs).map(([k]) => k);

function openProfile(p) {
  const tab = newTab({ cwd: p.cwd || null });
  if (p.command) runInPane(tab.focus, p.command);
}

/* ───────── Espacios de trabajo (grupos de pestañas) ───────── */
const mkWs = (name, color) => ({ id: ++wsSeq, name, color: color || WS_COLORS[workspaces.length % WS_COLORS.length], tabs: [], active: null });

function renderWsSwitcher() {
  const b = $('#ws-btn'); if (!b || !curWs) return;
  const pending = workspaces.some((w) => w !== curWs && w.tabs.some((t) => t.bell));
  b.replaceChildren(...[h('span', { class: 'ws-dot', style: `background:${curWs.color}` }), h('span', { class: 'ws-name' }, curWs.name), pending ? h('span', { class: 'dot', title: 'Hay avisos en otro espacio de trabajo' }) : null, icon('down', 12)].filter(Boolean));
  b.title = `Espacio de trabajo: ${curWs.name} (${workspaces.length})`;
}

function switchWorkspace(ws) {
  if (!ws || ws === curWs) return;
  curWs = ws; tabs = ws.tabs;
  $('#stage').querySelectorAll('.tabview.active').forEach((v) => v.classList.remove('active'));
  if (!tabs.length) newTab({ cwd: null });
  else selectTab(tabs.includes(ws.active) ? ws.active : tabs[0]);
  renderWsSwitcher(); renderTabs(); scheduleSave();
}
function cycleWorkspace(d) { switchWorkspace(workspaces[(workspaces.indexOf(curWs) + d + workspaces.length) % workspaces.length]); }

async function newWorkspace() {
  const name = await askInput({ title: 'Nuevo espacio de trabajo', placeholder: 'Nombre (p. ej. Backend, Servidores, Ocio)', okLabel: 'Crear' });
  if (!name) return focusPane(activeTab?.focus);
  const ws = mkWs(name); workspaces.push(ws); switchWorkspace(ws);
  toast(`Espacio “${name}” creado`);
}
async function renameWorkspace(ws = curWs) {
  const name = await askInput({ title: 'Renombrar espacio de trabajo', value: ws.name, okLabel: 'Guardar' });
  if (name) { ws.name = name; renderWsSwitcher(); scheduleSave(); }
  focusPane(activeTab?.focus);
}
function recolorWorkspace(ws = curWs) { ws.color = WS_COLORS[(WS_COLORS.indexOf(ws.color) + 1) % WS_COLORS.length]; renderWsSwitcher(); scheduleSave(); }

/** Quita un espacio (ya sin pestañas) y pasa al vecino. */
function dropWorkspace(ws) {
  const i = workspaces.indexOf(ws); workspaces.splice(i, 1);
  if (curWs === ws) { curWs = null; switchWorkspace(workspaces[Math.max(0, i - 1)]); } else renderWsSwitcher();
  scheduleSave();
}
async function deleteWorkspace(ws = curWs) {
  if (workspaces.length < 2) return toast('Debe quedar al menos un espacio de trabajo');
  const all = ws.tabs.flatMap((t) => leaves(t.root));
  if (!(await confirmBusy(all, `el espacio “${ws.name}” (${ws.tabs.length} pestaña${ws.tabs.length === 1 ? '' : 's'})`))) return focusPane(activeTab?.focus);
  for (const t of [...ws.tabs]) { leaves(t.root).forEach(destroyPane); t.view.remove(); }
  ws.tabs.length = 0;
  dropWorkspace(ws);
  toast(`Espacio “${ws.name}” eliminado`);
}

function moveTabToWs(tab, ws) {
  if (ws === tab.ws) return;
  const from = tab.ws, i = from.tabs.indexOf(tab);
  from.tabs.splice(i, 1); ws.tabs.push(tab); tab.ws = ws; tab.view.classList.remove('active');
  if (from === curWs) {
    if (from.tabs.length) { if (activeTab === tab) selectTab(from.tabs[Math.max(0, i - 1)]); else renderTabs(); }
    else { ws.active = tab; switchWorkspace(ws); toast(`Pestaña movida a “${ws.name}”`); return; }
  }
  ws.active = ws.active || tab;
  renderTabs(); scheduleSave(); toast(`Pestaña movida a “${ws.name}”`);
}

function wsMenu(x, y) {
  showMenu(x, y, [
    ...workspaces.map((w, i) => ({ label: `${w === curWs ? '●' : '○'}  ${w.name}  ·  ${w.tabs.length}${w !== curWs && w.tabs.some((t) => t.bell) ? '  · aviso' : ''}`, kbd: i < 9 ? `Ctrl+Alt+${i + 1}` : '', run: () => switchWorkspace(w) })),
    { sep: true },
    { label: 'Nuevo espacio de trabajo…', kbd: labelOf('newWorkspace', getConfig().keys), run: newWorkspace },
    { label: 'Renombrar este espacio…', run: () => renameWorkspace() },
    { label: 'Cambiar su color', run: () => recolorWorkspace() },
    { label: 'Eliminar este espacio…', disabled: workspaces.length < 2, run: () => deleteWorkspace() },
  ]);
}

function tabMenu(x, y, t) {
  const others = workspaces.filter((w) => w !== t.ws);
  showMenu(x, y, [
    { label: 'Renombrar', run: () => { selectTab(t); const el = $('#tabs .tab.active .name'); el && renameTab(t, el); } },
    { label: 'Duplicar (mismo directorio)', run: () => { selectTab(t); newTab({ cwd: t.focus?.cwd || null }); } },
    { sep: true },
    ...others.map((w) => ({ label: `Mover a “${w.name}”`, run: () => moveTabToWs(t, w) })),
    { label: 'Mover a un espacio nuevo…', run: async () => { const name = await askInput({ title: 'Mover a un espacio nuevo', placeholder: 'Nombre del espacio', okLabel: 'Crear y mover' }); if (name) { const ws = mkWs(name); workspaces.push(ws); moveTabToWs(t, ws); } } },
    { sep: true },
    { label: 'Cerrar otras pestañas', disabled: tabs.length < 2, run: async () => { for (const o of [...tabs].filter((z) => z !== t)) if (await confirmBusy(leaves(o.root), 'la pestaña')) closeTab(o); } },
    { label: 'Cerrar pestaña', run: () => requestCloseTab(t) },
  ]);
}

/* ───────── Pestañas laterales, modo zen, tamaño de interfaz y ventana ───────── */
function applyTabsPosition() {
  const left = getConfig().ui.tabs === 'left';
  document.body.classList.toggle('vtabs', left);
  $('#vtabs').hidden = !left;
  if (left) { $('#vt-ws').append($('#ws-btn')); $('#vt-tabs').append($('#tabs')); }
  else { $('#ws-slot').append($('#ws-btn')); $('#tabs-slot').prepend($('#tabs')); }
  document.documentElement.style.setProperty('--vtabs-w', `${getConfig().vtabsWidth}px`);
}
function setTabsPosition(pos) { saveConfig({ ui: { tabs: pos } }); applyConfig(); }

const clampScale = (v) => Math.min(1.6, Math.max(0.75, Math.round(v * 100) / 100));
function setUiScale(v) { saveConfig({ ui: { scale: clampScale(v) } }); applyConfig(); toast(`Interfaz al ${Math.round(clampScale(v) * 100)} %`); }

function toggleZen() {
  const on = document.body.classList.toggle('zen');
  if (on) toast(`Modo zen: ${labelOf('zen', getConfig().keys)} para salir`);
  scheduleFit(); setTimeout(scheduleFit, 80);
}
async function toggleFullscreen() { await transport.win.setFullscreen(!(await transport.win.isFullscreen())); setTimeout(scheduleFit, 150); }
let onTop = false;
async function toggleOnTop() { onTop = !onTop; await transport.win.setAlwaysOnTop(onTop); toast(onTop ? 'Ventana siempre visible' : 'Ventana normal'); }
async function setWindowSize(w, h) {
  await transport.win.setSize(w, h);
  saveConfig({ window: { w, h } });
  toast(transport.kind === 'tauri' ? `Ventana ${w}×${h}` : 'Cambiar el tamaño de la ventana solo funciona en la app de escritorio');
}
async function initWindow() {
  const c = getConfig().window;
  if (transport.kind !== 'tauri' || !c.remember) return;
  try { await transport.win.setSize(c.w, c.h); } catch {}
  let t = 0;
  transport.win.onResize(() => { clearTimeout(t); t = setTimeout(async () => { try { const s = await transport.win.size(); if (s.w > 200 && s.h > 150) saveConfig({ window: { w: s.w, h: s.h } }); } catch {} }, 600); });
}

/* ───────── Acciones ───────── */
function focusPane(p) {
  if (!p) return;
  if (vi?.active && vi.pane !== p) vi.exit();
  if (hints?.active) hints.exit();
  const tab = p.tab || activeTab;
  if (tab) tab.focus = p;
  panes.forEach((q) => q.el.classList.toggle('focused', q === p));
  p.term.focus(); updateStatus();
}

function split(dir) {
  const tab = activeTab, cur = tab.focus;
  tab.zoom = null;
  const np = createPane(getConfig().inheritCwd ? cur.cwd : null);
  const { node, parent } = findParent(tab.root, cur);
  const repl = { dir, ratio: 0.5, a: { pane: cur }, b: { pane: np } };
  if (!parent) tab.root = repl; else (parent.a === node ? (parent.a = repl) : (parent.b = repl));
  renderTab(tab);
  tab.focus = np;
  requestAnimationFrame(() => { startPane(np); focusPane(np); renderTabs(); });
  scheduleSave();
  return np;
}

function closePane(p = activeTab.focus) {
  const tab = p.tab || activeTab;
  const ls = leaves(tab.root);
  if (ls.length === 1) return closeTab(tab);
  if (tab.zoom === p) tab.zoom = null;
  const { parent } = findParent(tab.root, p);
  const sibling = parent.a.pane === p ? parent.b : parent.a;
  const gp = findParentOfNode(tab.root, parent);
  if (!gp) tab.root = sibling; else (gp.a === parent ? (gp.a = sibling) : (gp.b = sibling));
  destroyPane(p);
  tab.focus = leaves(tab.root)[0];
  renderTab(tab);
  if (tab === activeTab) focusPane(tab.focus);
  renderTabs(); scheduleSave();
}

function moveFocus(d) {
  const ls = leaves(activeTab.root); if (ls.length < 2 || activeTab.zoom) return;
  focusPane(ls[(ls.indexOf(activeTab.focus) + d + ls.length) % ls.length]);
}
function cycleTab(d) { selectTab(tabs[(tabs.indexOf(activeTab) + d + tabs.length) % tabs.length]); }
function zoomFont(d) {
  const size = Math.min(28, Math.max(9, d === 0 ? 14 : getConfig().font.size + d));
  saveConfig({ font: { size } }); applyConfig();
}
function toggleZoom() {
  const t = activeTab; if (leaves(t.root).length < 2) return toast('Solo hay un panel');
  t.zoom = t.zoom ? null : t.focus;
  renderTab(t); focusPane(t.focus); updateStatus(); syncActions();
}
function toggleBroadcast() { broadcast = !broadcast; syncActions(); updateStatus(); toast(broadcast ? 'Broadcast activado: lo que escribas va a todos los paneles' : 'Broadcast desactivado'); }
function fitAll() { panes.forEach(fitPane); updateStatus(); }
function clearPane() { activeTab.focus.term.clear(); }
function scrollbackText(p) {
  const b = p.term.buffer.active, out = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\s+$/, '');
}
function copyLastOutput() {
  const out = lastOutput(activeTab.focus);
  if (out === null) return toast('No conozco la salida del último comando (necesita la integración de shell y un comando ya terminado)', 'error');
  if (!out) return toast('El último comando no imprimió nada');
  copyText(out, true); toast(`Salida copiada (${out.split('\n').length} línea${out.includes('\n') ? 's' : ''})`);
}

/** Sustituye las variables {{nombre}} de un snippet preguntando su valor. Devuelve null si se cancela. */
async function fillVars(cmd) {
  const names = [...new Set([...cmd.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]))];
  const values = {};
  for (const n of names) {
    const v = await askInput({ title: `Valor para «${n}»`, placeholder: n, okLabel: 'Usar' });
    if (v === null) { focusPane(activeTab?.focus); return null; }
    values[n] = v;
  }
  return cmd.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, n) => values[n]);
}

async function openScrollbackPager() {
  const p = activeTab.focus;
  const file = await transport.writeTemp(`scrollback-${p.id}.txt`, scrollbackText(p));
  openTool(`less -R +G ${shq(file)}`, 'tab');
}
async function exportHtml() {
  const p = activeTab.focus;
  const file = await transport.writeTemp(`vexor-${Date.now()}.html`, p.serialize.serializeAsHTML({ includeGlobalBackground: true }));
  copyText(file, true); toast(`Exportado a ${file} (ruta copiada)`);
}

async function openTool(cmd, mode = 'tab', cwd) {
  const pane = mode === 'split' ? split('row') : newTab(cwd ? { cwd } : {}).focus;
  await runInPane(pane, cmd);
}

function paneMenu(x, y, p) {
  const sel = p.term.getSelection();
  showMenu(x, y, [
    { label: 'Copiar', kbd: 'Ctrl+Shift+C', disabled: !sel, run: () => copyText(sel) },
    { label: 'Pegar', kbd: 'Ctrl+Shift+V', run: () => pasteInto(p) },
    { label: 'Seleccionar todo', run: () => p.term.selectAll() },
    { sep: true },
    { label: 'Buscar…', kbd: labelOf('find', getConfig().keys), run: openFind },
    { label: 'Modo vi (seleccionar con teclado)', kbd: labelOf('viMode', getConfig().keys), run: () => vi.enter(p) },
    { label: 'Hints (URLs, rutas, hashes…)', kbd: labelOf('hints', getConfig().keys), run: () => hints.enter(p) },
    { label: sel ? 'Preguntar a la IA sobre la selección' : 'Preguntar a la IA sobre la salida', run: () => panel.ask(sel ? 'Explica esto:' : 'Explica la salida anterior y dime cómo solucionarla.', true) },
    { sep: true },
    { label: 'Dividir a la derecha', kbd: labelOf('splitRight', getConfig().keys), run: () => split('row') },
    { label: 'Dividir abajo', kbd: labelOf('splitDown', getConfig().keys), run: () => split('col') },
    { label: activeTab.zoom ? 'Restaurar panel' : 'Maximizar panel', kbd: labelOf('zoomPane', getConfig().keys), run: toggleZoom },
    { label: 'Cerrar panel', kbd: labelOf('closePane', getConfig().keys), run: () => requestClosePane(p) },
    { sep: true },
    { label: 'Limpiar pantalla', kbd: labelOf('clear', getConfig().keys), run: clearPane },
    { label: 'Abrir historial en pager (less)', run: openScrollbackPager },
    { label: 'Copiar la salida del último comando', kbd: labelOf('copyOutput', getConfig().keys), run: copyLastOutput },
    { label: 'Copiar todo el historial', run: () => copyText(scrollbackText(p)) },
    { label: 'Exportar historial a HTML', run: exportHtml },
  ]);
}

/* ───────── Contexto para la IA ───────── */
function getContext(maxLines = 40) {
  const p = activeTab.focus;
  const sel = p.term.getSelection().trim();
  if (sel) return { text: sel, kind: 'selection', cwd: p.cwd, git: p.git };
  const b = p.term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, b.length - 400); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  const text = lines.join('\n').trimEnd().split('\n').slice(-maxLines).join('\n');
  return { text, kind: 'terminal', cwd: p.cwd, git: p.git };
}

/* ───────── Estado (cwd / git / proceso / sistema) ───────── */
async function pollStatus() {
  if (document.hidden || !transport || !activeTab) return;
  const ps = [...panes.values()].filter((p) => p.started);
  const [cwds, fgs] = await Promise.all([Promise.all(ps.map((p) => transport.cwd(p.id))), Promise.all(ps.map((p) => transport.fg(p.id)))]);
  let changed = false;
  ps.forEach((p, i) => {
    if (cwds[i] && cwds[i] !== p.cwd) { p.cwd = cwds[i]; changed = true; }
    if ((fgs[i] || null) !== p.fg) { p.fg = fgs[i] || null; changed = true; }
  });
  const f = activeTab.focus, now = performance.now();
  if (f?.cwd && (f.gitFor !== f.cwd || f.gitStale || now - (f.gitAt || 0) > 6000)) {
    f.gitFor = f.cwd; f.gitAt = now; f.gitStale = false;
    f.git = await transport.git(f.cwd);
  }
  if (changed) { renderTabs(); scheduleSave(); }
  updateStatus();
}
async function pollSys() {
  if (document.hidden || !transport) return;
  const s = await transport.sys();
  if (!s) return;
  const now = performance.now(), prev = sysHist.prev;
  if (prev && now > prev.t) { const dt = (now - prev.t) / 1000; sysHist.rx = Math.max(0, (s.net_rx - prev.rx) / dt); sysHist.tx = Math.max(0, (s.net_tx - prev.tx) / dt); }
  sysHist.prev = { t: now, rx: s.net_rx || 0, tx: s.net_tx || 0 };
  sysHist.cpu.push(s.cpu); if (sysHist.cpu.length > 60) sysHist.cpu.shift();
  sys = s; updateStatus();
}

const home = () => getConfig()._home;
const tilde = (p) => (home() && p?.startsWith(home()) ? '~' + p.slice(home().length) : p);
const gb = (b) => (b / 1073741824).toFixed(1);

let statusSig = '';
function updateStatus() {
  const p = activeTab?.focus; if (!p) return;
  const ls = leaves(activeTab.root).length;
  const it = (...c) => h('span', { class: 'item' }, ...c);
  const meter = (label, pct, text) => h('span', { class: 'meter', title: `${label} ${text}` }, label, h('span', { class: `bar${pct > 85 ? ' hot' : ''}` }, h('i', { style: `width:${Math.round(pct)}%` })), text);
  const last = p.last && Date.now() - p.last.at < 120000 ? p.last : null;
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sig = [p.id, p.cwd, p.title, p.git?.branch, p.git?.dirty, p.fg, last?.exit, last?.at, viActive, broadcast, !!activeTab.zoom, sys && Math.round(sys.cpu), sys && gb(sys.mem_used), p.term.cols, p.term.rows, ls, tabs.length, getConfig().theme, clock].join('|');
  if (sig === statusSig) return;
  statusSig = sig;
  $('#status').replaceChildren(...[
    p.cwd ? it(icon('folder', 12), h('span', { class: 'cwd' }, tilde(p.cwd))) : it(h('span', { class: 'cwd' }, p.title)),
    p.git ? it(h('span', { class: 'git' }, icon('branch', 12), `${p.git.branch}${p.git.dirty ? ' *' : ''}`)) : null,
    p.fg ? it(h('span', { class: 'fg', title: 'Proceso en primer plano' }, `▶ ${p.fg}`)) : null,
    last ? h('span', { class: `last ${last.exit === 0 ? 'is-ok' : 'is-fail'}`, title: 'Último comando' }, last.exit === 0 ? '✓' : `✗ ${last.exit}`, fmtDuration(last.dur)) : null,
    h('span', { class: 'spacer' }),
    viActive ? h('span', { class: 'badge' }, 'VI') : null,
    broadcast ? h('span', { class: 'badge' }, 'BROADCAST') : null,
    activeTab.zoom ? h('span', { class: 'badge' }, 'MAXIMIZADO') : null,
    sys ? meter('CPU', sys.cpu, `${Math.round(sys.cpu)}%`) : null,
    sys && sys.mem_total ? meter('RAM', (sys.mem_used / sys.mem_total) * 100, `${gb(sys.mem_used)}/${gb(sys.mem_total)} GB`) : null,
    it(`${p.term.cols}×${p.term.rows}`),
    it(`${ls} panel${ls === 1 ? '' : 'es'} · ${tabs.length} pestaña${tabs.length === 1 ? '' : 's'}`),
    it(getConfig().theme),
    h('span', { class: 'item clock' }, clock),
  ].filter(Boolean));
}

/* ───────── Búsqueda ───────── */
const find = { case: false, re: false, q: '' };
const findOpts = () => ({
  caseSensitive: find.case, regex: find.re,
  decorations: { matchBackground: '#3d4256', activeMatchBackground: '#d19a46', matchOverviewRuler: '#7a8199', activeMatchColorOverviewRuler: '#d19a46' },
});
function setFindCount(r) { $('#find-count').textContent = r && r.resultCount ? `${r.resultIndex + 1}/${r.resultCount}` : $('#find-input').value ? 'sin resultados' : ''; }
function findStep(q, dir) { const s = activeTab.focus.search; try { dir > 0 ? s.findNext(q, findOpts()) : s.findPrevious(q, findOpts()); } catch {} }
function doFind(dir = 1) {
  const q = $('#find-input').value, s = activeTab.focus.search;
  find.q = q;
  if (!q) { s.clearDecorations(); setFindCount(null); return; }
  try { dir > 0 ? s.findNext(q, findOpts()) : s.findPrevious(q, findOpts()); } catch { $('#find-count').textContent = 'regex no válida'; }
}
function openFind() {
  $('#findbar').hidden = false;
  const sel = activeTab.focus.term.getSelection();
  if (sel && !sel.includes('\n')) $('#find-input').value = sel;
  $('#find-input').focus(); $('#find-input').select();
  if ($('#find-input').value) doFind();
}
function closeFind() { $('#findbar').hidden = true; activeTab.focus.search.clearDecorations(); activeTab.focus.term.clearSelection(); focusPane(activeTab.focus); }
$('#find-prev').append(icon('up', 15)); $('#find-next').append(icon('down', 15)); $('#find-close').append(icon('x', 15));
$('#find-input').addEventListener('input', () => doFind());
$('#find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') closeFind();
});
$('#find-next').addEventListener('click', () => doFind(1));
$('#find-prev').addEventListener('click', () => doFind(-1));
$('#find-close').addEventListener('click', closeFind);
for (const [id, k] of [['#find-case', 'case'], ['#find-re', 're']]) {
  $(id).addEventListener('click', () => { find[k] = !find[k]; $(id).classList.toggle('on', find[k]); doFind(); });
}

/* ───────── Atajos (configurables) ───────── */
const runners = {
  newTab: () => newTab(), newWindow: () => transport.newWindow(activeTab?.focus?.cwd).catch((e) => toast(String(e?.message || e), 'error')),
  splitRight: () => split('row'), splitDown: () => split('col'), closePane: () => requestClosePane(), zoomPane: () => toggleZoom(),
  nextPane: () => moveFocus(1), prevPane: () => moveFocus(-1), nextTab: () => cycleTab(1), prevTab: () => cycleTab(-1),
  moveTabLeft: () => moveTab(tabs.indexOf(activeTab), tabs.indexOf(activeTab) - 1), moveTabRight: () => moveTab(tabs.indexOf(activeTab), tabs.indexOf(activeTab) + 1),
  broadcast: () => toggleBroadcast(), find: () => openFind(), viMode: () => vi.enter(activeTab.focus), hints: () => hints.enter(activeTab.focus),
  prevPrompt: () => jumpPrompt(activeTab.focus, -1), nextPrompt: () => jumpPrompt(activeTab.focus, 1),
  aibar: () => aibar.open(), panelAi: () => panel.toggle('ai'), panelGit: () => panel.toggle('git'), panelDocker: () => panel.toggle('docker'),
  panelSnippets: () => panel.toggle('snippets'), panelTools: () => panel.toggle('tools'), panelFiles: () => panel.toggle('files'), panelTasks: () => panel.toggle('tasks'),
  panelSystem: () => panel.toggle('system'), panelNotes: () => panel.toggle('notes'), panelApi: () => panel.toggle('api'), copyOutput: () => copyLastOutput(), toggleSide: () => (panel.open ? panel.hide() : panel.show()),
  history: () => hist.open(), zen: () => toggleZen(), fullscreen: () => toggleFullscreen(),
  newWorkspace: () => newWorkspace(), nextWorkspace: () => cycleWorkspace(1), prevWorkspace: () => cycleWorkspace(-1),
  uiUp: () => setUiScale(getConfig().ui.scale + 0.05), uiDown: () => setUiScale(getConfig().ui.scale - 0.05), uiReset: () => setUiScale(1), palette: () => togglePalette(), clear: () => clearPane(),
  settings: () => settings.open(), help: () => openHelp(), fontUp: () => zoomFont(1), fontDown: () => zoomFont(-1), fontReset: () => zoomFont(0),
};
function runAction(id) {
  const m = /^goTab(\d)$/.exec(id), w = /^goWs(\d)$/.exec(id);
  if (m) { const t = tabs[+m[1] - 1]; if (t) selectTab(t); return; }
  if (w) { switchWorkspace(workspaces[+w[1] - 1]); return; }
  runners[id]?.();
}
const overlaysOpen = () => ['#palette', '#settings', '#aibar', '#help', '#dialog', '#history'].some((s) => !$(s).hidden);

function shortcut(e) {
  const combo = comboFromEvent(e); if (!combo) return false;
  const id = bindings.get(combo); if (!id) return false;
  e.preventDefault(); runAction(id);
  return true;
}
addEventListener('keydown', (e) => { if (overlaysOpen() || vi?.active || hints?.active) return; shortcut(e); }, true);

/* ───────── Ayuda de atajos ───────── */
function openHelp() {
  const root = $('#help');
  const keys = getConfig().keys;
  const grid = h('div', { class: 'keys' }, h('div', { class: 'k-group' }, 'Atajos'));
  for (const a of ACTIONS.filter((x) => !/^go(Tab|Ws)\d$/.test(x.id))) grid.append(h('span', { class: 'k-name' }, a.name), h('kbd', {}, labelOf(a.id, keys) || '—'));
  grid.append(h('span', { class: 'k-name' }, 'Ir a la pestaña N'), h('kbd', {}, 'Alt+1…9'));
  grid.append(h('span', { class: 'k-name' }, 'Ir al espacio de trabajo N'), h('kbd', {}, 'Ctrl+Alt+1…9'));
  grid.append(h('div', { class: 'k-group' }, 'Terminal y ratón'));
  for (const [n, k] of [['Copiar / pegar', 'Ctrl+Shift+C / V'], ['Abrir enlace (URL, OSC 8)', 'Ctrl+clic'], ['Selección de palabra / línea', 'doble / triple clic'], ['Menú contextual', 'clic derecho'], ['Imágenes en la terminal', 'Sixel · iTerm (imgcat, chafa)']]) grid.append(h('span', { class: 'k-name' }, n), h('kbd', {}, k));
  grid.append(h('div', { class: 'k-group' }, 'Modo vi'));
  for (const [n, k] of [['Moverse', 'h j k l · w b e · 0 ^ $ · gg G'], ['Página / media página', 'Ctrl+f b · Ctrl+d u'], ['Seleccionar (carácter / línea)', 'v · V'], ['Copiar selección / línea', 'y · Y'], ['Buscar siguiente / anterior', 'n · N'], ['Salir', 'Esc · q']]) grid.append(h('span', { class: 'k-name' }, n), h('kbd', {}, k));
  root.tabIndex = -1;
  root.replaceChildren(h('div', { class: 'modal wide' }, h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, 'Atajos de teclado'), h('button', { class: 'icon-btn', onclick: closeHelp }, icon('x', 15))), grid));
  root.hidden = false;
  root.focus();
}
function closeHelp() { $('#help').hidden = true; focusPane(activeTab?.focus); }
$('#help').addEventListener('mousedown', (e) => e.target.id === 'help' && closeHelp());
addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#help').hidden) { e.preventDefault(); closeHelp(); } }, true);

/* ───────── Paleta de comandos ───────── */
let sel = 0, items = [];
const fuzzy = (q, s) => {
  q = q.toLowerCase(); s = s.toLowerCase();
  let i = 0, score = 0, last = -2;
  for (const ch of q) { const j = s.indexOf(ch, i); if (j < 0) return -1; score += j === last + 1 ? 3 : 1; last = j; i = j + 1; }
  return score - s.length * 0.01;
};
const commands = () => [
  ...ACTIONS.filter((a) => !/^go(Tab|Ws)\d$/.test(a.id)).map((a) => ({ name: a.name, kbd: labelOf(a.id, getConfig().keys), run: () => runAction(a.id) })),
  ...workspaces.map((w, i) => ({ name: `Espacio: ${w.name}`, kbd: i < 9 ? `Ctrl+Alt+${i + 1}` : '', swatch: w.color, run: () => switchWorkspace(w) })),
  { name: 'Renombrar espacio de trabajo', run: () => renameWorkspace() },
  { name: 'Eliminar espacio de trabajo', run: () => deleteWorkspace() },
  { name: getConfig().ui.tabs === 'left' ? 'Pestañas: mostrar arriba' : 'Pestañas: mostrar en barra lateral', run: () => setTabsPosition(getConfig().ui.tabs === 'left' ? 'top' : 'left') },
  ...[[1100, 700], [1280, 800], [1500, 900], [1800, 1000]].map(([w, hh]) => ({ name: `Ventana: ${w}×${hh}`, run: () => setWindowSize(w, hh) })),
  { name: 'Ventana: siempre visible (activar/desactivar)', run: toggleOnTop },
  { name: 'Renombrar pestaña', run: () => { const el = $('#tabs .tab.active .name'); el && renameTab(activeTab, el); } },
  { name: 'Igualar el tamaño de los paneles', run: () => { equalize(activeTab.root); renderTab(activeTab); scheduleSave(); } },
  { name: 'Abrir historial en pager (less)', run: openScrollbackPager },
  { name: 'Copiar todo el historial del panel', run: () => copyText(scrollbackText(activeTab.focus)) },
  { name: 'Exportar historial a HTML', run: exportHtml },
  { name: 'Guardar layout actual…', run: saveLayout },
  ...layoutNames().flatMap((n) => [
    { name: `Layout: ${n}`, run: () => restoreTabs(getConfig().layouts[n], { append: true }) },
    { name: `Eliminar layout: ${n}`, run: async () => { await saveConfig({ layouts: { [n]: null } }); toast(`Layout “${n}” eliminado`); } },
  ]),
  ...getConfig().profiles.map((p) => ({ name: `Perfil: ${p.name}`, kbd: p.command || p.cwd || '', run: () => openProfile(p) })),
  ...sshHosts.filter((x) => /^[\w.@-]+$/.test(x)).map((x) => ({ name: `SSH: ${x}`, kbd: `ssh ${x}`, run: () => openTool(`ssh ${x}`, 'tab') })),
  { name: 'Editar configuración (JSON)', run: () => openTool('${EDITOR:-nano} "${XDG_CONFIG_HOME:-$HOME/.config}/vexor/config.json"', 'tab') },
  { name: 'Recargar configuración', run: async () => { await loadConfig(transport); applyConfig(); toast('Configuración recargada'); } },
  { name: 'IA: explicar el último error', run: () => panel.ask('Explica el error o la salida anterior y dime cómo solucionarlo.', true) },
  { name: 'IA: corregir el último comando', run: () => panel.ask('El último comando falló o no hizo lo que esperaba. Dame el comando corregido.', true) },
  ...tabs.map((t, i) => ({ name: `Ir a pestaña ${i + 1}: ${tabLabel(t)}`, kbd: i < 9 ? `Alt+${i + 1}` : '', run: () => selectTab(t) })),
  ...getConfig().snippets.map((s) => ({ name: `Snippet: ${s.name}`, kbd: s.cmd.slice(0, 28), run: async () => { const c = await fillVars(s.cmd); if (c) insertText(c); } })),
  ...(getConfig().bookmarks || []).map((b) => ({ name: `Favorito: ${tilde(b)}`, kbd: 'cd', run: () => runText(`cd ${shq(b)}`) })),
  ...Object.keys(themes).map((n) => ({ name: `Tema: ${n}`, swatch: themes[n].ui.accent, run: () => { saveConfig({ theme: n }); applyConfig(); } })),
];
function drawPalette() {
  const q = $('#palette-input').value.trim();
  const all = commands();
  items = q ? all.map((c) => [fuzzy(q, c.name), c]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c) : all;
  sel = Math.min(sel, Math.max(0, items.length - 1));
  const ul = $('#palette-list'); ul.replaceChildren();
  items.forEach((c, i) => {
    const li = h('li', { class: i === sel ? 'sel' : '' }, h('span', {}, c.swatch ? h('i', { class: 'swatch', style: `background:${c.swatch}` }) : null, c.name), c.kbd ? h('kbd', {}, c.kbd) : null);
    li.addEventListener('click', () => runItem(c));
    ul.append(li);
  });
  ul.children[sel]?.scrollIntoView({ block: 'nearest' });
}
function runItem(c) { closePalette(true); c.run(); }
function togglePalette() { $('#palette').hidden ? openPalette() : closePalette(); }
function openPalette() { $('#palette').hidden = false; $('#palette-input').value = ''; sel = 0; drawPalette(); $('#palette-input').focus(); }
function closePalette(skipFocus) { $('#palette').hidden = true; if (!skipFocus) focusPane(activeTab?.focus); }
$('#palette-input').addEventListener('input', () => { sel = 0; drawPalette(); });
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePalette();
  else if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); drawPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); drawPalette(); e.preventDefault(); }
  else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); runItem(items[sel]); } // preventDefault: que el Enter no llegue a la terminal
  else if (comboFromEvent(e) === labelOf('palette', getConfig().keys)) closePalette();
});
$('#palette').addEventListener('mousedown', (e) => { if (e.target.id === 'palette') closePalette(); });

/* ───────── Barra superior: acciones ───────── */
function syncActions() {
  const box = $('#tabbar-actions'); box.replaceChildren();
  const k = (id) => labelOf(id, getConfig().keys);
  const btn = (ic, title, fn, on = false) => h('button', { class: 'icon-btn' + (on ? ' on' : ''), title, 'aria-label': title, onclick: fn }, icon(ic, 16));
  box.append(
    btn('search', `Buscar (${k('find')})`, openFind),
    btn('broadcast', `Broadcast a todos los paneles (${k('broadcast')})`, toggleBroadcast, broadcast),
    btn('zoom', `Maximizar panel (${k('zoomPane')})`, toggleZoom, !!activeTab?.zoom),
    h('span', { class: 'sep' }),
    btn('wand', `Comando con IA (${k('aibar')})`, () => aibar.open()),
    btn('sidebar', `Panel lateral: IA, Git, archivos, tareas… (${k('toggleSide')})`, () => (panel.open ? panel.hide() : panel.show()), !!panel?.open),
    h('span', { class: 'sep' }),
    btn('command', `Paleta de comandos (${k('palette')})`, openPalette),
    btn('settings', `Ajustes (${k('settings')})`, () => settings.open()),
  );
}

/* ───────── Animación de inicio (estilo futurista) ───────── */
function bootSplash() {
  const c = getConfig().ui;
  if (c.style === 'clean' || !c.boot || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const [k, v] of Object.entries((themes[getConfig().theme] ?? themes['Vexor Night']).ui)) document.documentElement.style.setProperty(`--${k}`, v);
  const el = h('div', { id: 'boot', 'aria-hidden': 'true' }, h('div', { class: 'boot-box' },
    h('div', { class: 'boot-mark' }), h('div', { class: 'boot-name' }, 'VEXOR'),
    h('div', { class: 'boot-lines' }, ...['PTY · RUST', 'SHELL · INTEGRACIÓN', 'INTERFAZ'].map((t, i) => h('div', { style: `animation-delay:${0.05 + i * 0.08}s` }, h('span', {}, t), h('b', {}, 'OK')))),
    h('div', { class: 'boot-bar' }, h('i'))));
  document.body.append(el);
  setTimeout(() => el.classList.add('out'), 420);
  setTimeout(() => el.remove(), 640);
}

/* ───────── API para los paneles ───────── */
const insertText = (t) => { const p = activeTab.focus; focusPane(p); p.term.paste(t); };
const runText = (t) => { const p = activeTab.focus; focusPane(p); p.term.paste(t); transport.write(p.id, '\r'); };

(async () => {
  try { transport = await createTransport(); }
  catch (e) { document.body.append(h('pre', { style: 'padding:24px;color:#ec6a75' }, `No se pudo iniciar el backend de Vexor:\n${e?.message || e}`)); return; }
  await loadConfig(transport);
  bootSplash();
  transport.onData(onPtyData);
  transport.onExit((id) => { const p = panes.get(id); if (p?.tab) closePane(p); });
  transport.onFileDrop?.((paths) => { if (paths?.length && activeTab) insertText(paths.map(shq).join(' ') + ' '); });
  transport.sshHosts().then((x) => { sshHosts = x || []; });

  const app = {
    transport, getConfig, saveConfig, applyConfig, getContext,
    insert: insertText, run: runText, openTool, openLink, fillVars, getSys: () => ({ sys, hist: sysHist }), newTabAt: (cwd) => newTab({ cwd }), setWindowSize, focusPane, openFind, findStep,
    lastFind: () => find.q,
    onViChange: (st) => { viActive = !!st; updateStatus(); },
    aiId: () => ++aiSeq,
    getCwd: () => activeTab?.focus?.cwd || null,
    openSettings: () => settings.open(),
    focusTerminal: () => activeTab && focusPane(activeTab.focus),
    relayout: () => { scheduleFit(); syncActions(); },
  };
  panel = initSidePanel(app);
  settings = initSettings(app);
  aibar = initAiBar(app);
  vi = createVi(app);
  hints = createHints(app);
  hist = createHistory(app);
  background = initBackground(getConfig);
  workspaces = [mkWs('Principal')]; curWs = workspaces[0]; tabs = curWs.tabs;

  applyConfig();
  syncActions();
  new ResizeObserver(scheduleFit).observe($('#stage'));

  const launch = await transport.launchArgs();
  if (launch.cwd || launch.command || launch.noRestore) {
    const tab = newTab({ cwd: launch.cwd || null });
    if (launch.command) runInPane(tab.focus, launch.command);
  } else if (!(getConfig().restoreSession && restoreSession(getConfig().session))) newTab({ cwd: null });
  renderWsSwitcher();
  $('#ws-btn').addEventListener('click', (e) => { const r = e.currentTarget.getBoundingClientRect(); wsMenu(r.left, r.bottom + 4); });
  $('#newtab-btn').replaceChildren(icon('plus', 16));
  for (const id of ['#newtab-btn', '#vt-new']) $(id).addEventListener('click', () => newTab());
  initWindow();

  pollStatus(); pollSys();
  setInterval(pollStatus, 1500);
  setInterval(pollSys, 3000);
  window.vexor = {
    newTab, split, closePane, panes, tabs: () => tabs, panel, settings, openFind, commands, active: () => activeTab,
    saveSession, vi, hints, runAction, openProfile, snapshot, jumpPrompt, applyConfig, transport,
    workspaces: () => workspaces, curWs: () => curWs, switchWorkspace, newWorkspace, setUiScale, hist,
    setConfig: async (patch) => { await saveConfig(patch); applyConfig(); },
  };
})();
