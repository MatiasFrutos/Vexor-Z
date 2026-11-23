// Panel lateral: Asistente IA · Git · Docker · Snippets · Herramientas.
import { h, icon, toast } from './ui.js';
import { renderMarkdown } from './md.js';
import { buildExtraViews } from './panels2.js';

const FENCE = '```';
const SYSTEM = [
  'Eres Vexor AI, el asistente integrado en una terminal Linux (Arch/Omarchy con Hyprland).',
  'Responde siempre en español, breve y directo.',
  `Cuando propongas comandos, ponlos en bloques ${FENCE}bash, un comando por bloque y sin comentarios dentro.`,
  'Si el usuario pide un comando, da primero el bloque y después, como mucho, dos líneas de explicación.',
  'Si te pasan salida de terminal, indica la causa probable del error y cómo corregirlo.',
  'Advierte claramente antes de proponer algo destructivo (rm -rf, mkfs, dd, sobrescribir archivos…).',
].join(' ');

const TOOLS = [
  { group: 'IA en la terminal', items: [
    { name: 'Claude Code', bin: 'claude', cmd: 'claude', desc: 'Agente de programación de Anthropic' },
    { name: 'Codex CLI', bin: 'codex', cmd: 'codex', desc: 'Agente de OpenAI' },
    { name: 'Gemini CLI', bin: 'gemini', cmd: 'gemini', desc: 'Agente de Google' },
    { name: 'Aider', bin: 'aider', cmd: 'aider', desc: 'Pair programming con git' },
    { name: 'Ollama', bin: 'ollama', cmd: 'ollama list', desc: 'Modelos locales' },
  ] },
  { group: 'Desarrollo', items: [
    { name: 'Lazygit', bin: 'lazygit', cmd: 'lazygit', desc: 'Interfaz de git' },
    { name: 'Neovim', bin: 'nvim', cmd: 'nvim', desc: 'Editor' },
    { name: 'Node REPL', bin: 'node', cmd: 'node', desc: 'JavaScript interactivo' },
    { name: 'Python REPL', bin: 'python3', cmd: 'python3', desc: 'Python interactivo' },
    { name: 'Servidor HTTP aquí', bin: 'python3', cmd: 'python3 -m http.server 8000', desc: 'Sirve la carpeta actual en :8000' },
  ] },
  { group: 'Sistema', items: [
    { name: 'btop', bin: 'btop', cmd: 'btop', desc: 'Monitor de recursos' },
    { name: 'Yazi', bin: 'yazi', cmd: 'yazi', desc: 'Explorador de archivos' },
    { name: 'Fastfetch', bin: 'fastfetch', cmd: 'fastfetch', desc: 'Información del sistema' },
    { name: 'Puertos en escucha', bin: 'ss', cmd: 'ss -tulpn', desc: 'Servicios y puertos abiertos' },
    { name: 'Procesos por memoria', bin: 'ps', cmd: 'ps aux --sort=-%mem | head -15', desc: 'Los 15 que más consumen' },
  ] },
];

const errText = (e) => String(e?.message || e || 'error desconocido');

export function initSidePanel(app) {
  const root = document.querySelector('#side');
  const views = {};
  let current = 'ai';
  let timer = 0;

  /* ───────── Asistente IA ───────── */
  const messages = (app.getConfig().chat || []).map((m) => ({ role: m.role, content: m.content }));
  let busy = false, activeBubble = null, raf = 0;

  const log = h('div', { class: 'ai-log' });
  const input = h('textarea', { class: 'ai-text', rows: '2', placeholder: 'Pregunta o describe el comando que necesitas…' });
  const ctxBox = h('input', { type: 'checkbox', checked: true });
  const sendBtn = h('button', { class: 'btn primary', title: 'Enviar (Enter)', onclick: () => (busy ? cancel() : ask(input.value)) });
  const meta = h('div', { class: 'ai-meta' });
  const actions = { insert: (t) => app.insert(t), run: (t) => app.run(t) };
  const persist = () => app.saveConfig({ chat: messages.filter((m) => !m.error).slice(-30).map(({ role, content }) => ({ role, content })) });

  const quick = (label, fn) => h('button', { class: 'chip', onclick: fn }, label);
  const chips = h('div', { class: 'ai-quick' },
    quick('Explicar error', () => ask('Explica el error o la salida anterior y dime cómo solucionarlo.', true)),
    quick('Corregir comando', () => ask('El último comando falló o no hizo lo que esperaba. Dame el comando corregido.', true)),
    quick('Resumir salida', () => ask('Resume esta salida en pocas líneas.', true)),
    quick('Comando…', () => { input.value = 'Dame el comando para '; input.focus(); }),
  );

  function renderLog() {
    log.replaceChildren();
    if (!messages.length) {
      log.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-title' }, 'Vexor AI'),
        h('p', {}, 'Pregunta lo que necesites. Con “Incluir terminal” activado, el asistente ve la selección o las últimas líneas del panel activo.'),
        h('ul', {}, h('li', {}, '“Dame el comando para comprimir esta carpeta”'), h('li', {}, '“¿Por qué falló el build?”'), h('li', {}, '“Explica este error de cargo”')),
      ));
    }
    messages.forEach((m, i) => {
      const bubble = h('div', { class: `msg ${m.role}` });
      fillBubble(bubble, m, i === messages.length - 1 && busy);
      log.append(bubble);
      m.el = bubble;
    });
    log.scrollTop = log.scrollHeight;
  }

  function fillBubble(el, m, streaming = false) {
    el.replaceChildren();
    if (m.role === 'user') {
      el.append(h('div', { class: 'user-text' }, m.content));
      if (m.ctx) el.append(h('div', { class: 'ctx-tag' }, m.ctx.kind === 'selection' ? 'contexto: selección' : `contexto: ${m.ctx.lines} líneas de terminal`));
      return;
    }
    const body = h('div', { class: 'md' });
    renderMarkdown(m.content, body, actions, streaming);
    el.append(body);
    if (!m.content && streaming) el.append(h('div', { class: 'thinking' }, 'Pensando'));
    if (m.error) el.append(h('div', { class: 'err' }, m.error));
  }

  function setBusy(b) {
    busy = b;
    sendBtn.replaceChildren(icon(b ? 'stop' : 'send', 15), b ? 'Detener' : 'Enviar');
    input.disabled = b;
  }

  function refreshMeta() {
    const c = app.getConfig().ai;
    const name = c.provider === 'anthropic' ? 'Anthropic' : 'Compatible OpenAI';
    meta.replaceChildren(...[
      h('span', {}, `${name} · ${c.model || '—'}`),
      !c.hasKey && c.provider === 'anthropic' ? h('button', { class: 'link warn', onclick: () => app.openSettings() }, 'Falta la API key') : null,
    ].filter(Boolean));
  }

  async function ask(text, forceCtx = null) {
    text = text.trim();
    if (!text || busy) return;
    const ctx = (forceCtx ?? ctxBox.checked) ? app.getContext() : null;
    const user = { role: 'user', content: text };
    if (ctx?.text) {
      user.ctx = { kind: ctx.kind, lines: ctx.text.split('\n').length };
      user.api = `[cwd: ${ctx.cwd || '?'}${ctx.git ? ` · git: ${ctx.git.branch}${ctx.git.dirty ? '*' : ''}` : ''}]\n<${ctx.kind}>\n${ctx.text}\n</${ctx.kind}>\n\n${text}`;
    }
    const bot = { role: 'assistant', content: '' };
    messages.push(user, bot);
    input.value = '';
    const hist = messages.slice(0, -1).slice(-12).map((m, i, arr) => ({ role: m.role, content: i === arr.length - 1 ? (m.api ?? m.content) : m.content }));
    const id = app.aiId();
    activeBubble = { id, msg: bot };
    setBusy(true);
    renderLog();
    try { await app.transport.aiChat(id, { system: SYSTEM, messages: hist }); }
    catch (e) { bot.error = errText(e); finish(); }
  }

  function cancel() { if (activeBubble) { app.transport.aiCancel(activeBubble.id); finish(); } }
  function finish() {
    if (!activeBubble) return;
    const { msg } = activeBubble;
    activeBubble = null;
    setBusy(false);
    if (!msg.content && !msg.error) messages.splice(messages.indexOf(msg) - 1, 2);
    renderLog();
    refreshMeta();
    persist();
  }

  app.transport.onAi((ev) => {
    if (!activeBubble || ev.id !== activeBubble.id) return;
    if (ev.kind === 'chunk') {
      activeBubble.msg.content += ev.text;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        if (!activeBubble) return;
        fillBubble(activeBubble.msg.el, activeBubble.msg, true);
        log.scrollTop = log.scrollHeight;
      });
    } else if (ev.kind === 'error') { activeBubble.msg.error = ev.text; finish(); }
    else if (ev.kind === 'done') finish();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
    else if (e.key === 'Escape') app.focusTerminal();
  });

  views.ai = h('section', { class: 'view' },
    log, chips,
    h('div', { class: 'ai-compose' }, input, sendBtn),
    h('div', { class: 'ai-foot' },
      h('label', { class: 'check' }, ctxBox, 'Incluir terminal'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link', onclick: () => { if (!busy) { messages.length = 0; renderLog(); persist(); } } }, 'Limpiar'),
    ),
    meta,
  );
  setBusy(false);

  /* ───────── Git ───────── */
  const gitBox = h('div', { class: 'list' });
  let gitFirst = true;
  async function renderGit() {
    const cwd = app.getCwd();
    if (gitFirst) gitBox.replaceChildren(h('div', { class: 'empty small' }, 'Cargando…'));
    const g = cwd ? await app.transport.gitStatus(cwd) : null;
    gitFirst = false;
    if (current !== 'git') return;
    if (!g) { gitBox.replaceChildren(h('div', { class: 'empty small' }, cwd ? 'Este directorio no es un repositorio git.' : 'Sin directorio activo todavía.')); return; }
    const act = (label, cmd, run = true) => h('button', { class: 'chip', title: cmd, onclick: () => (run ? app.run(cmd) : app.insert(cmd)) }, label);
    gitBox.replaceChildren(
      h('div', { class: 'toolbar' },
        h('span', { class: 'pill' }, icon('branch', 13), g.branch || '(sin rama)'),
        g.ahead ? h('span', { class: 'pill plain', title: 'commits por subir' }, `↑${g.ahead}`) : null,
        g.behind ? h('span', { class: 'pill plain', title: 'commits por bajar' }, `↓${g.behind}`) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'Actualizar', onclick: () => renderGit() }, icon('refresh', 15)),
      ),
      h('div', { class: 'toolbar' }, act('Pull', 'git pull'), act('Push', 'git push'), act('Añadir todo', 'git add -A'), act('Commit…', 'git commit -m ""', false)),
      h('div', { class: 'group' }, `Cambios (${g.files.length})`),
      ...(g.files.length
        ? g.files.map((f) => h('div', { class: 'row' },
            h('span', { class: `st ${f.status.replace('?', '\\?')}` }, f.status || '?'),
            h('div', { class: 'row-main' }, h('div', { class: 'row-title mono', title: f.path }, f.path)),
            h('span', { class: 'acts' },
              h('button', { class: 'icon-btn', title: 'Insertar ruta', onclick: () => app.insert(f.path) }, icon('insert', 15)),
              h('button', { class: 'icon-btn', title: 'git diff', onclick: () => app.run(`git diff -- ${JSON.stringify(f.path)}`) }, icon('logs', 15)))))
        : [h('div', { class: 'empty small' }, 'Árbol de trabajo limpio ✓')]),
      h('div', { class: 'group' }, 'Últimos commits'),
      ...g.commits.map((c) => h('div', { class: 'row' },
        h('code', { class: 'hash' }, c.hash),
        h('div', { class: 'row-main' }, h('div', { class: 'row-title', title: c.subject }, c.subject), h('div', { class: 'row-sub' }, c.when)),
        h('span', { class: 'acts' }, h('button', { class: 'icon-btn', title: 'git show', onclick: () => app.run(`git show ${c.hash}`) }, icon('logs', 15))))),
    );
  }
  views.git = h('section', { class: 'view' }, gitBox);

  /* ───────── Docker ───────── */
  const dockBox = h('div', { class: 'list' });
  let dockFirst = true;
  async function renderDocker() {
    if (dockFirst) dockBox.replaceChildren(h('div', { class: 'empty small' }, 'Cargando…'));
    let list;
    try { list = await app.transport.dockerPs(); }
    catch (e) { dockFirst = false; if (current === 'docker') dockBox.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'empty-title' }, 'Docker no disponible'), errText(e))); return; }
    dockFirst = false;
    if (current !== 'docker') return;
    const act = async (action, name) => {
      try { await app.transport.dockerAction(action, name); toast(`${name}: ${action} ✓`); }
      catch (e) { toast(errText(e), 'error'); }
      renderDocker();
    };
    const running = list.filter((c) => c.State === 'running').length;
    dockBox.replaceChildren(
      h('div', { class: 'toolbar' },
        h('span', { class: 'pill plain' }, `${running}/${list.length} en ejecución`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'Actualizar', onclick: () => renderDocker() }, icon('refresh', 15))),
      ...(list.length ? list.map((c) => {
        const up = c.State === 'running';
        return h('div', { class: 'row' },
          h('span', { class: `sdot ${c.State}` }),
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, c.Names), h('div', { class: 'row-sub', title: `${c.Image} · ${c.Status}` }, `${c.Image} · ${c.Status}`)),
          h('span', { class: 'acts' },
            h('button', { class: 'icon-btn', title: 'Ver logs', onclick: () => app.openTool(`docker logs -f --tail 200 ${c.Names}`, 'tab') }, icon('logs', 15)),
            up ? h('button', { class: 'icon-btn', title: 'Abrir shell', onclick: () => app.openTool(`docker exec -it ${c.Names} sh`, 'tab') }, icon('terminal', 15)) : null,
            h('button', { class: 'icon-btn', title: 'Reiniciar', onclick: () => act('restart', c.Names) }, icon('restart', 15)),
            h('button', { class: 'icon-btn', title: up ? 'Detener' : 'Iniciar', onclick: () => act(up ? 'stop' : 'start', c.Names) }, icon(up ? 'stop' : 'play', 14))));
      }) : [h('div', { class: 'empty small' }, 'No hay contenedores.')]),
    );
  }
  views.docker = h('section', { class: 'view' }, dockBox);

  /* ───────── Snippets ───────── */
  const snipList = h('div', { class: 'list' });
  const sName = h('input', { class: 'field', placeholder: 'Nombre' });
  const sCmd = h('input', { class: 'field mono', placeholder: 'Comando — usa {{variable}} para pedir un valor' });
  const saveSnips = (list) => app.saveConfig({ snippets: list });

  function renderSnippets() {
    const list = app.getConfig().snippets;
    snipList.replaceChildren(...list.map((s, i) =>
      h('div', { class: 'row' },
        h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, s.name), h('code', { class: 'row-sub' }, s.cmd)),
        h('span', { class: 'acts' },
          h('button', { class: 'icon-btn', title: 'Insertar', onclick: async () => { const c = await app.fillVars(s.cmd); if (c) app.insert(c); } }, icon('insert', 15)),
          h('button', { class: 'icon-btn', title: 'Ejecutar', onclick: async () => { const c = await app.fillVars(s.cmd); if (c) app.run(c); } }, icon('play', 15)),
          h('button', { class: 'icon-btn', title: 'Eliminar', onclick: async () => { await saveSnips(list.filter((_, j) => j !== i)); renderSnippets(); } }, icon('trash', 15))))));
    if (!list.length) snipList.append(h('div', { class: 'empty small' }, 'Sin snippets todavía.'));
  }
  const addSnippet = async () => {
    const name = sName.value.trim(), cmd = sCmd.value.trim();
    if (!name || !cmd) return;
    await saveSnips([...app.getConfig().snippets, { name, cmd }]);
    sName.value = sCmd.value = '';
    renderSnippets();
    toast('Snippet guardado');
  };
  sCmd.addEventListener('keydown', (e) => e.key === 'Enter' && addSnippet());
  views.snippets = h('section', { class: 'view' },
    snipList,
    h('div', { class: 'form' }, sName, sCmd, h('button', { class: 'btn', onclick: addSnippet }, icon('plus', 14), 'Añadir snippet')),
  );

  /* ───────── Herramientas ───────── */
  const toolsBox = h('div', { class: 'list' });
  async function renderTools() {
    const bins = [...new Set(TOOLS.flatMap((g) => g.items.map((t) => t.bin)))];
    const found = await app.transport.which(bins);
    const has = (bin) => found[bins.indexOf(bin)];
    toolsBox.replaceChildren(h('div', { class: 'hint' }, 'Clic: nueva pestaña · Mayús+clic: panel dividido'));
    for (const g of TOOLS) {
      toolsBox.append(h('div', { class: 'group' }, g.group));
      for (const t of g.items) {
        const ok = has(t.bin);
        toolsBox.append(h('button', {
          class: `row${ok ? '' : ' off'}`, title: ok ? t.cmd : `${t.bin} no está instalado`,
          onclick: (e) => ok && app.openTool(t.cmd, e.shiftKey ? 'split' : 'tab'),
        },
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, t.name), h('div', { class: 'row-sub' }, ok ? t.desc : `${t.bin} no instalado`)),
          ok ? icon('play', 14) : null));
      }
    }
  }
  views.tools = h('section', { class: 'view' }, toolsBox);

  /* ───────── Cabecera, navegación y redimensionado ───────── */
  const extra = buildExtraViews(app);
  Object.assign(views, extra.views);
  const tabDefs = [['ai', 'IA', 'ai'], ['git', 'Git', 'git'], ['files', 'Archivos', 'folder'], ['tasks', 'Tareas', 'tasks'], ['docker', 'Docker', 'docker'], ['system', 'Sistema', 'pulse'], ['api', 'API', 'globe'], ['snippets', 'Snippets', 'snippets'], ['notes', 'Notas', 'note'], ['tools', 'Herramientas', 'tools']];
  const nav = h('div', { class: 'side-nav' }, tabDefs.map(([id, label, ic]) =>
    h('button', { class: 'seg', 'data-view': id, title: label, onclick: () => show(id) }, icon(ic, 15), h('span', { class: 'lbl' }, label))));
  const head = h('div', { class: 'side-head' }, nav, h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: 'Ajustes', onclick: () => app.openSettings() }, icon('settings', 15)),
    h('button', { class: 'icon-btn', title: 'Cerrar', onclick: () => hide() }, icon('x', 15)));
  const grip = h('div', { class: 'side-resize', title: 'Arrastra para cambiar el ancho' });
  root.append(grip, head, ...Object.values(views));

  const setWidth = (w) => document.documentElement.style.setProperty('--side-w', `${Math.round(Math.min(720, Math.max(320, w)))}px`);
  setWidth(app.getConfig().panelWidth);
  grip.addEventListener('mousedown', (ev) => {
    ev.preventDefault(); grip.classList.add('drag');
    const move = (e) => { setWidth(innerWidth - e.clientX); app.relayout(); };
    const up = () => {
      grip.classList.remove('drag'); removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      app.saveConfig({ panelWidth: Math.round(root.getBoundingClientRect().width) });
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });

  const refreshers = { git: renderGit, docker: renderDocker, ...extra.refreshers };
  function show(view = current) {
    current = view;
    root.hidden = false;
    document.body.classList.add('side-open');
    nav.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    nav.querySelector('.seg.on')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    Object.entries(views).forEach(([k, v]) => (v.hidden = k !== view));
    if (view === 'ai') { refreshMeta(); renderLog(); input.focus(); }
    if (view === 'snippets') renderSnippets();
    if (view === 'tools') renderTools();
    if (view === 'git') gitFirst = true;
    if (view === 'docker') dockFirst = true;
    if (extra.onShow[view]) extra.onShow[view](); else refreshers[view]?.();
    clearInterval(timer);
    timer = refreshers[view] ? setInterval(() => !document.hidden && refreshers[view](), { git: 4000, files: 3000, tasks: 3000, system: 3000 }[view] || 5000) : 0;
    app.relayout();
  }
  function hide() { root.hidden = true; clearInterval(timer); document.body.classList.remove('side-open'); app.relayout(); app.focusTerminal(); }
  const toggle = (view) => (!root.hidden && current === view ? hide() : show(view));

  return { show, hide, toggle, ask: (t, ctx) => { show('ai'); return ask(t, ctx); }, get open() { return !root.hidden; }, get view() { return current; } };
}
