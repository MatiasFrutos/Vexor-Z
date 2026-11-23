// Paneles laterales adicionales: Archivos · Tareas del proyecto · Sistema (procesos y puertos) · Notas.
import { h, icon, toast } from './ui.js';
import { confirmBox } from './dialogs.js';
import { buildApiView, renderOverview } from './panels3.js';

const errText = (e) => String(e?.message || e || 'error');
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);

export function buildExtraViews(app) {
  const views = {}, refreshers = {};
  const T = app.transport;

  /* ───────── Archivos ───────── */
  const files = { dir: null, hidden: false, follow: true, filter: '', last: null };
  const filesBox = h('div', { class: 'list' });
  const crumbs = h('div', { class: 'crumbs' });
  const filter = h('input', { class: 'field sm', placeholder: 'Filtrar…', 'aria-label': 'Filtrar archivos' });
  const followBox = h('input', { type: 'checkbox', checked: true });
  const hiddenBox = h('input', { type: 'checkbox' });
  filter.addEventListener('input', () => { files.filter = filter.value.toLowerCase(); drawFiles(); });
  followBox.addEventListener('change', () => { files.follow = followBox.checked; if (files.follow) loadDir(app.getCwd()); });
  hiddenBox.addEventListener('change', () => { files.hidden = hiddenBox.checked; loadDir(files.dir); });

  const favs = h('div', { class: 'favs', hidden: true });
  const starBtn = h('button', { class: 'icon-btn', title: 'Añadir o quitar esta carpeta de favoritos', onclick: () => toggleFav() }, icon('star', 15));
  async function toggleFav() {
    const d = files.dir; if (!d) return;
    const cur = app.getConfig().bookmarks || [], had = cur.includes(d);
    await app.saveConfig({ bookmarks: had ? cur.filter((x) => x !== d) : [...cur, d] });
    drawFavs(); toast(had ? 'Quitado de favoritos' : 'Añadido a favoritos');
  }
  function drawFavs() {
    const list = app.getConfig().bookmarks || [];
    starBtn.classList.toggle('on', list.includes(files.dir));
    favs.hidden = !list.length;
    favs.replaceChildren(...list.map((p) => h('button', { class: 'chip', title: `${p} — clic: abrir aquí · Mayús+clic: cd en la terminal`, onclick: (e) => (e.shiftKey ? app.run(`cd ${shq(p)}`) : go(p)) }, icon('star', 12), p.split('/').filter(Boolean).pop() || '/')));
  }

  async function loadDir(path) {
    if (!path) { filesBox.replaceChildren(h('div', { class: 'empty small' }, 'Sin directorio activo todavía.')); return; }
    try { files.last = await T.listDir(path, files.hidden); files.dir = files.last.path; drawFiles(); }
    catch (e) { toast(errText(e), 'error'); }
  }
  function drawFiles() {
    const d = files.last; if (!d) return;
    drawFavs();
    const parts = d.path.split('/').filter(Boolean);
    crumbs.replaceChildren(h('button', { class: 'crumb', title: 'Raíz', onclick: () => go('/') }, '/'),
      ...parts.map((p, i) => h('button', { class: 'crumb', onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, p)));
    crumbs.scrollLeft = crumbs.scrollWidth;
    const list = d.entries.filter((e) => !files.filter || e.name.toLowerCase().includes(files.filter));
    filesBox.replaceChildren(
      ...(d.parent ? [h('button', { class: 'row', onclick: () => go(d.parent) }, icon('up', 15), h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, '..')))] : []),
      ...list.map((e) => {
        const full = `${d.path === '/' ? '' : d.path}/${e.name}`;
        const acts = e.dir
          ? [h('button', { class: 'icon-btn', title: 'cd aquí (en la terminal)', onclick: (ev) => { ev.stopPropagation(); app.run(`cd ${shq(full)}`); } }, icon('play', 14)),
             h('button', { class: 'icon-btn', title: 'Terminal nueva aquí', onclick: (ev) => { ev.stopPropagation(); app.newTabAt(full); } }, icon('terminal', 14))]
          : [h('button', { class: 'icon-btn', title: 'Abrir en el editor', onclick: (ev) => { ev.stopPropagation(); app.openTool(`\${EDITOR:-nano} ${shq(full)}`, 'tab'); } }, icon('note', 14)),
             h('button', { class: 'icon-btn', title: 'Ver con less', onclick: (ev) => { ev.stopPropagation(); app.openTool(`less ${shq(full)}`, 'tab'); } }, icon('logs', 14))];
        return h('div', { class: 'row', role: 'button', tabindex: '0', title: full,
          onclick: () => (e.dir ? go(full) : app.insert(shq(full) + ' ')),
          onkeydown: (ev) => ev.key === 'Enter' && (e.dir ? go(full) : app.insert(shq(full) + ' ')) },
          icon(e.dir ? 'folder' : 'file', 15),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, e.name)),
          h('span', { class: 'row-sub right' }, e.dir ? '' : fmtSize(e.size)),
          h('span', { class: 'acts' }, ...acts));
      }),
      ...(d.truncated ? [h('div', { class: 'hint' }, 'Mostrando los primeros 1000 elementos')] : []),
      ...(!list.length ? [h('div', { class: 'empty small' }, files.filter ? 'Sin coincidencias.' : 'Carpeta vacía.')] : []),
    );
  }
  function go(path) { files.follow = false; followBox.checked = false; loadDir(path); }
  views.files = h('section', { class: 'view' },
    h('div', { class: 'toolbar tight' }, h('button', { class: 'icon-btn', title: 'Directorio de la terminal', onclick: () => { files.follow = true; followBox.checked = true; loadDir(app.getCwd()); } }, icon('terminal', 15)),
      h('button', { class: 'icon-btn', title: 'Carpeta personal', onclick: () => go('~') }, icon('home', 15)), starBtn, filter,
      h('button', { class: 'icon-btn', title: 'Actualizar', onclick: () => loadDir(files.dir) }, icon('refresh', 15))),
    favs, crumbs, filesBox,
    h('div', { class: 'ai-foot' }, h('label', { class: 'check' }, followBox, 'Seguir la terminal'), h('label', { class: 'check' }, hiddenBox, 'Ocultos'), h('span', { class: 'spacer' }), h('span', { class: 'hint' }, 'Clic: insertar ruta')));
  refreshers.files = () => { if (files.follow) { const c = app.getCwd(); if (c && c !== files.dir) loadDir(c); } else if (!files.last) loadDir(app.getCwd()); };
  const showFiles = () => { if (!files.last || files.follow) loadDir(app.getCwd() || '~'); else drawFiles(); };

  /* ───────── Tareas del proyecto ───────── */
  const tasksBox = h('div', { class: 'list' });
  let tasksKey = '';
  const KIND = { npm: 'npm / pnpm / yarn', cargo: 'Cargo', make: 'Make', just: 'Just', compose: 'Docker Compose' };
  async function renderTasks(force) {
    const cwd = app.getCwd();
    if (!cwd) { tasksBox.replaceChildren(h('div', { class: 'empty small' }, 'Sin directorio activo todavía.')); return; }
    let r; try { r = await T.projectTasks(cwd); } catch (e) { tasksBox.replaceChildren(h('div', { class: 'empty small' }, errText(e))); return; }
    const key = cwd + JSON.stringify(r.groups.map((g) => g.tasks.length));
    if (!force && key === tasksKey) return;
    tasksKey = key;
    if (!r.groups.length) { tasksBox.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'empty-title' }, 'Sin tareas'), 'No encuentro package.json, Cargo.toml, Makefile, justfile ni compose en este directorio ni en los de arriba.')); return; }
    tasksBox.replaceChildren(h('div', { class: 'hint' }, `Proyecto: ${r.root}`), h('div', { class: 'hint' }, 'Clic: ejecutar en una pestaña nueva · Mayús+clic: en la terminal actual'),
      ...r.groups.flatMap((g) => [
        h('div', { class: 'group' }, `${KIND[g.kind] || g.kind} · ${g.file}`),
        ...g.tasks.map((t) => h('button', { class: 'row', title: t.cmd, onclick: (ev) => (ev.shiftKey ? app.run(`cd ${shq(r.root)} && ${t.cmd}`) : app.openTool(t.cmd, 'tab', r.root)) },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, t.name), h('code', { class: 'row-sub' }, t.cmd)), icon('play', 14))),
      ]));
  }
  views.tasks = h('section', { class: 'view' }, tasksBox);
  refreshers.tasks = () => renderTasks(false);

  /* ───────── Sistema: procesos y puertos ───────── */
  const sys = { tab: 'over', filter: '' };
  const sysBox = h('div', { class: 'list' });
  const sysFilter = h('input', { class: 'field sm', placeholder: 'Filtrar…', 'aria-label': 'Filtrar' });
  const seg = h('div', { class: 'seg2' }, ...[['over', 'Resumen'], ['proc', 'Procesos'], ['ports', 'Puertos']].map(([id, label]) => h('button', { 'data-t': id, class: id === 'over' ? 'on' : '', onclick: () => { sys.tab = id; seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === id)); renderSys(); } }, label)));
  sysFilter.addEventListener('input', () => { sys.filter = sysFilter.value.toLowerCase(); renderSys(); });
  async function kill(pid, name, sig) {
    if (!(await confirmBox({ title: sig === 'KILL' ? 'Matar proceso' : 'Terminar proceso', message: `¿Enviar ${sig === 'KILL' ? 'SIGKILL (forzado)' : 'SIGTERM'} a “${name}” (PID ${pid})?`, okLabel: sig === 'KILL' ? 'Matar' : 'Terminar' }))) return;
    try { await T.killProc(pid, sig); toast(`${name} (${pid}): ${sig} enviada`); } catch (e) { toast(errText(e), 'error'); }
    setTimeout(renderSys, 500);
  }
  async function renderSys() {
    sysFilter.style.visibility = sys.tab === 'over' ? 'hidden' : '';
    if (sys.tab === 'over') return renderOverview(app, sysBox);
    if (sys.tab === 'proc') {
      const list = (await T.ps()).filter((p) => !sys.filter || `${p.name} ${p.cmd} ${p.pid} ${p.user}`.toLowerCase().includes(sys.filter)).slice(0, 150);
      sysBox.replaceChildren(h('div', { class: 'tbl-head' }, h('span', { class: 'c-name' }, 'Proceso'), h('span', { class: 'c-num' }, 'CPU'), h('span', { class: 'c-num' }, 'RAM'), h('span', { class: 'c-act' })),
        ...list.map((p) => h('div', { class: 'row proc', title: p.cmd },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, p.name), h('div', { class: 'row-sub' }, `PID ${p.pid} · ${p.user} · ${p.time}`)),
          h('span', { class: 'c-num' + (p.cpu > 50 ? ' hot' : '') }, `${p.cpu.toFixed(1)}%`), h('span', { class: 'c-num' }, `${p.mem.toFixed(1)}%`),
          h('span', { class: 'acts show' }, h('button', { class: 'icon-btn', title: 'Terminar (Mayús: matar)', onclick: (ev) => kill(p.pid, p.name, ev.shiftKey ? 'KILL' : 'TERM') }, icon('x', 14))))),
        ...(!list.length ? [h('div', { class: 'empty small' }, 'Sin resultados.')] : []));
    } else {
      let all; try { all = await T.ports(); } catch (e) { sysBox.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'empty-title' }, 'No se pueden listar los puertos'), errText(e))); return; }
      const list = all.filter((p) => !sys.filter || `${p.port} ${p.process} ${p.proto} ${p.addr}`.toLowerCase().includes(sys.filter));
      sysBox.replaceChildren(h('div', { class: 'tbl-head' }, h('span', { class: 'c-name' }, 'Puerto'), h('span', { class: 'c-num wide' }, 'Proceso'), h('span', { class: 'c-act big' })),
        ...list.map((p) => h('div', { class: 'row proc', title: `${p.proto} ${p.addr}:${p.port}` },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title mono' }, `:${p.port}`), h('div', { class: 'row-sub' }, `${p.proto} · ${p.addr}`)),
          h('span', { class: 'c-num wide' }, p.process ? `${p.process}${p.pid ? ` (${p.pid})` : ''}` : '—'),
          h('span', { class: 'acts show' },
            p.proto === 'tcp' ? h('button', { class: 'icon-btn', title: 'Abrir http://localhost:' + p.port, onclick: () => app.openLink(`http://localhost:${p.port}`) }, icon('sidebar', 14)) : null,
            h('button', { class: 'icon-btn', title: 'Copiar localhost:' + p.port, onclick: () => { navigator.clipboard?.writeText(`localhost:${p.port}`); toast('Copiado'); } }, icon('copy', 14)),
            p.pid ? h('button', { class: 'icon-btn', title: 'Terminar el proceso', onclick: (ev) => kill(p.pid, p.process || `puerto ${p.port}`, ev.shiftKey ? 'KILL' : 'TERM') }, icon('x', 14)) : null))),
        ...(!list.length ? [h('div', { class: 'empty small' }, 'No hay puertos en escucha.')] : []));
    }
  }
  views.system = h('section', { class: 'view' }, h('div', { class: 'toolbar tight' }, seg, h('span', { class: 'spacer' }), sysFilter), sysBox);
  refreshers.system = renderSys;

  /* ───────── Notas ───────── */
  const notes = h('textarea', { class: 'notes', placeholder: 'Notas rápidas: comandos, TODOs, apuntes… (se guardan solas)', spellcheck: 'false', 'aria-label': 'Notas' });
  const count = h('span', { class: 'hint' });
  let t = 0;
  notes.value = app.getConfig().notes || '';
  const upd = () => (count.textContent = `${notes.value.length} caracteres · guardado`);
  upd();
  notes.addEventListener('input', () => { count.textContent = 'guardando…'; clearTimeout(t); t = setTimeout(async () => { await app.saveConfig({ notes: notes.value }); upd(); }, 500); });
  views.notes = h('section', { class: 'view' }, notes,
    h('div', { class: 'ai-foot' }, count, h('span', { class: 'spacer' }),
      h('button', { class: 'link', onclick: () => { const sel = notes.value.slice(notes.selectionStart, notes.selectionEnd) || notes.value.split('\n')[notes.value.slice(0, notes.selectionStart).split('\n').length - 1]; if (sel.trim()) app.insert(sel.trim()); } }, 'Insertar línea/selección en la terminal'),
      h('button', { class: 'link', onclick: () => { navigator.clipboard?.writeText(notes.value); toast('Notas copiadas'); } }, 'Copiar')));

  const api = buildApiView(app);
  views.api = api.view;

  return {
    views, refreshers,
    onShow: { files: showFiles, tasks: () => renderTasks(true), system: renderSys, notes: () => notes.focus(), api: api.show },
    defs: [['files', 'Archivos', 'folder'], ['tasks', 'Tareas', 'tasks'], ['system', 'Sistema', 'pulse'], ['notes', 'Notas', 'note']],
  };
}
