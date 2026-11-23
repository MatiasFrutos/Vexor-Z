import { h, toast } from './ui.js';
import { themes } from './themes.js';
import { ACTIONS, comboFromEvent, buildBindings, labelOf, defaultOf, isCustom } from './keys.js';
import { BG_MODES, imageToDataUrl } from './background.js';

export function initSettings(app) {
  const root = document.querySelector('#settings');
  const field = (label, el, hint) => h('label', { class: 'set-row' }, h('span', { class: 'set-label' }, label), el, hint ? h('span', { class: 'set-hint' }, hint) : null);
  const sel = (opts) => h('select', { class: 'field' }, opts.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o))));
  const num = (min, max, step) => h('input', { class: 'field', type: 'number', min, max, step });
  const range = (min, max, step) => h('input', { class: 'range', type: 'range', min, max, step });
  const check = (label, el) => h('label', { class: 'check' }, el, label);
  const chk = () => h('input', { type: 'checkbox' });

  const f = {
    uiStyle: sel([['hud', 'Futurista (HUD)'], ['clean', 'Limpio']]), glow: chk(), boot: chk(),
    uiScale: range(0.75, 1.6, 0.05), tabsPos: sel([['top', 'Arriba (barra superior)'], ['left', 'Barra lateral izquierda']]),
    winRemember: chk(), winW: num(480, 7680, 10), winH: num(320, 4320, 10),
    theme: sel(Object.keys(themes)), family: h('input', { class: 'field mono' }),
    size: num(9, 28, 1), lh: num(1, 1.8, 0.05), ls: num(-2, 6, 0.5), weight: sel(['normal', '300', '500', '600']), bold: sel(['bold', '600', '700', '800']),
    cursor: sel(['bar', 'block', 'underline']), blink: chk(), scrollback: num(1000, 100000, 1000), scrollSens: num(0.2, 5, 0.1),
    bgMode: sel(BG_MODES), dim: range(0.3, 1, 0.01), blur: range(0, 20, 1), speed: range(0.3, 2.5, 0.1), opacity: range(0.3, 1, 0.01),
    shell: h('input', { class: 'field mono', placeholder: 'Por defecto: $SHELL' }), integ: chk(), restore: chk(), inherit: chk(), copySel: chk(),
    bell: chk(), flash: chk(), confirmClose: chk(), confirmPaste: chk(), notifyAfter: num(0, 3600, 1),
    provider: sel(['anthropic', 'openai']), baseUrl: h('input', { class: 'field mono', placeholder: 'https://api.anthropic.com' }),
    model: h('input', { class: 'field mono' }), key: h('input', { class: 'field mono', type: 'password', autocomplete: 'off' }),
  };
  let draft = null; // { keys, profiles, bgImage }
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const imgInfo = h('span', { class: 'set-hint' });

  /* ── pestañas ── */
  const panes = {};
  const scaleLabel = h('span', { class: 'set-hint' });
  f.uiScale.addEventListener('input', () => { document.documentElement.style.setProperty('--ui-scale', f.uiScale.value); scaleLabel.textContent = `${Math.round(f.uiScale.value * 100)} %`; });
  panes.interface = h('div', { class: 'tabpane' },
    h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Tamaño de la interfaz'), f.uiScale, scaleLabel,
      h('span', { class: 'set-hint' }, 'Escala barras, paneles, menús y ventanas (no el texto de la terminal: ese se cambia en Apariencia). Atajos: Ctrl+Alt+= / − / 0.')),
    field('Estilo', f.uiStyle, 'Futurista: esquinas en ángulo, rótulos técnicos y marcas en las esquinas del panel activo. Limpio: el aspecto anterior.'),
    check('Resplandor en los acentos (glow)', f.glow), check('Animación de inicio', f.boot),
    field('Pestañas', f.tabsPos, 'En la barra lateral caben más pestañas con nombre largo, junto al selector de espacios de trabajo.'),
    h('div', { class: 'set-group' }, 'Ventana'),
    check('Recordar el tamaño de la ventana', f.winRemember),
    h('div', { class: 'set-pair' }, field('Ancho (px)', f.winW), field('Alto (px)', f.winH)),
    h('p', { class: 'set-hint' }, 'El tamaño se aplica al guardar (app de escritorio). Con Hyprland en modo mosaico el tamaño lo decide el compositor; sirve para ventanas flotantes.'));
  panes.appearance = h('div', { class: 'tabpane' },
    field('Tema', f.theme), field('Fuente', f.family, 'Recomendada: JetBrainsMono Nerd Font'),
    h('div', { class: 'set-pair' }, field('Tamaño', f.size), field('Interlineado', f.lh)),
    h('div', { class: 'set-pair' }, field('Espaciado de letras (px)', f.ls), field('Sensibilidad de scroll', f.scrollSens)),
    h('div', { class: 'set-pair' }, field('Peso', f.weight), field('Peso de negrita', f.bold)),
    h('div', { class: 'set-pair' }, field('Cursor', f.cursor), field('Scrollback (líneas)', f.scrollback)),
    check('Cursor parpadeante', f.blink),
  );
  panes.background = h('div', { class: 'tabpane' },
    field('Fondo', f.bgMode),
    h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Imagen'), h('div', { class: 'row-inline' },
      h('button', { class: 'btn sm', onclick: () => fileInput.click() }, 'Elegir imagen…'),
      h('button', { class: 'btn sm', onclick: () => { draft.bgImage = ''; imgInfo.textContent = 'Sin imagen'; } }, 'Quitar'), imgInfo)),
    field('Oscurecer el fondo (legibilidad)', f.dim, 'Más a la derecha = el texto se lee mejor, el fondo se ve menos'),
    field('Desenfoque de la imagen (px)', f.blur), field('Velocidad de la animación', f.speed),
    field('Opacidad de la ventana', f.opacity, 'Menos de 100 % deja ver el escritorio (requiere compositor, p. ej. Hyprland con blur)'),
    fileInput,
  );
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    try { draft.bgImage = await imageToDataUrl(file); imgInfo.textContent = `${file.name} · ${Math.round(draft.bgImage.length / 1024)} KB`; f.bgMode.value = 'image'; }
    catch { toast('No se pudo leer la imagen', 'error'); }
    fileInput.value = '';
  });
  panes.behavior = h('div', { class: 'tabpane' },
    field('Shell', f.shell, 'Vacío = usa $SHELL. Ejemplos: /usr/bin/zsh, /usr/bin/fish'),
    check('Integración de shell (marcas de prompt, código de salida, avisos de comandos largos)', f.integ),
    check('Restaurar pestañas y paneles al abrir', f.restore),
    check('Nuevas pestañas y splits en el directorio actual', f.inherit),
    check('Copiar al seleccionar', f.copySel),
    check('Aviso en la pestaña cuando suene la campana', f.bell), check('Destello del panel con la campana', f.flash),
    check('Confirmar al cerrar si hay un proceso en ejecución', f.confirmClose),
    check('Confirmar al pegar varias líneas', f.confirmPaste),
    field('Notificar comandos que tarden más de (segundos, 0 = nunca)', f.notifyAfter, 'Solo avisa si Vexor está en segundo plano o en otra pestaña. Requiere la integración de shell.'),
  );
  const keysList = h('div', { class: 'keys-edit' });
  panes.keys = h('div', { class: 'tabpane' }, h('p', { class: 'set-hint' }, 'Clic en un atajo y pulsa la nueva combinación. Esc cancela; Retroceso lo quita.'), keysList);
  let capturing = null;
  function drawKeys() {
    const used = buildBindings(draft.keys);
    keysList.replaceChildren(...ACTIONS.map((a) => {
      const cur = labelOf(a.id, draft.keys);
      const btn = h('button', { class: 'keybtn' + (capturing === a.id ? ' cap' : '') }, capturing === a.id ? 'Pulsa una combinación…' : cur || '—');
      btn.addEventListener('click', () => { capturing = capturing === a.id ? null : a.id; drawKeys(); });
      const dup = cur && used.get(cur) !== a.id;
      return h('div', { class: 'key-row' }, h('span', { class: dup ? 'warn' : '' }, a.name, dup ? ' (en conflicto)' : ''), btn,
        isCustom(draft.keys, a.id) ? h('button', { class: 'link', onclick: () => { delete draft.keys[a.id]; drawKeys(); } }, 'Restablecer') : h('span'));
    }));
  }
  addEventListener('keydown', (e) => {
    if (root.hidden || !capturing) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { capturing = null; return drawKeys(); }
    if (e.key === 'Backspace' || e.key === 'Delete') { draft.keys[capturing] = ''; capturing = null; return drawKeys(); }
    const combo = comboFromEvent(e); if (!combo) return;
    if (combo === defaultOf(capturing)) delete draft.keys[capturing]; else draft.keys[capturing] = combo;
    capturing = null; drawKeys();
  }, true);

  const profList = h('div', { class: 'prof-list' });
  panes.profiles = h('div', { class: 'tabpane' }, h('p', { class: 'set-hint' }, 'Un perfil abre una pestaña en un directorio y ejecuta un comando (por ejemplo ssh, un proyecto, un REPL). Aparecen en la paleta como “Perfil: …”.'), profList,
    h('button', { class: 'btn sm', onclick: () => { draft.profiles.push({ name: 'Nuevo perfil', cwd: '', command: '' }); drawProfiles(); } }, '+ Añadir perfil'));
  function drawProfiles() {
    profList.replaceChildren(...draft.profiles.map((p, i) => {
      const inp = (k, ph, mono) => { const el = h('input', { class: 'field' + (mono ? ' mono' : ''), placeholder: ph, value: p[k] || '' }); el.addEventListener('input', () => (p[k] = el.value)); return el; };
      return h('div', { class: 'prof' }, inp('name', 'Nombre'), inp('cwd', 'Directorio (opcional)', true), inp('command', 'Comando (opcional)', true),
        h('button', { class: 'link', onclick: () => { draft.profiles.splice(i, 1); drawProfiles(); } }, 'Eliminar'));
    }));
  }
  panes.ai = h('div', { class: 'tabpane' },
    h('div', { class: 'presets' },
      ...[['Anthropic', { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' }],
        ['Ollama (local)', { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2' }],
        ['OpenAI', { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }]]
        .map(([label, p]) => h('button', { class: 'chip', onclick: () => { f.provider.value = p.provider; f.baseUrl.value = p.baseUrl; f.model.value = p.model; } }, label))),
    field('Proveedor', f.provider, 'anthropic = API de Anthropic · openai = cualquier API compatible (Ollama, LM Studio, OpenRouter…)'),
    field('URL base', f.baseUrl), field('Modelo', f.model),
    field('API key', f.key, 'Se guarda en ~/.config/vexor/config.json (permisos 0600). También se lee ANTHROPIC_API_KEY / OPENAI_API_KEY.'),
  );

  const tabDefs = [['interface', 'Interfaz'], ['appearance', 'Apariencia'], ['background', 'Fondo'], ['behavior', 'Comportamiento'], ['keys', 'Atajos'], ['profiles', 'Perfiles'], ['ai', 'IA']];
  const tabBar = h('div', { class: 'set-tabs' }, tabDefs.map(([id, label]) => h('button', { class: 'set-tab', 'data-tab': id, onclick: () => showTab(id) }, label)));
  const body = h('div', { class: 'modal-body' }, ...Object.values(panes));
  function showTab(id) {
    tabBar.querySelectorAll('.set-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    for (const [k, v] of Object.entries(panes)) v.hidden = k !== id;
    if (id === 'keys') drawKeys();
    if (id === 'profiles') drawProfiles();
  }
  const modal = h('div', { class: 'modal wide' },
    h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, 'Ajustes'), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Cerrar' }, '✕')),
    h('div', { class: 'set-layout' }, tabBar, body),
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: close }, 'Cancelar'), h('button', { class: 'btn primary', onclick: save }, 'Guardar')));
  root.append(modal);
  root.addEventListener('mousedown', (e) => e.target === root && close());
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !root.hidden && !capturing) { e.preventDefault(); close(); } }, true);

  function open(tab = 'interface') {
    const c = app.getConfig();
    f.uiScale.value = c.ui.scale; scaleLabel.textContent = `${Math.round(c.ui.scale * 100)} %`; f.tabsPos.value = c.ui.tabs; f.uiStyle.value = c.ui.style; f.glow.checked = !!c.ui.glow; f.boot.checked = c.ui.boot !== false;
    f.winRemember.checked = c.window.remember; f.winW.value = c.window.w; f.winH.value = c.window.h;
    draft = { keys: Object.fromEntries(Object.entries(c.keys).filter(([, v]) => v !== null && v !== undefined)), profiles: c.profiles.map((p) => ({ ...p })), bgImage: c.bg.image || '' };
    capturing = null;
    f.theme.value = c.theme; f.family.value = c.font.family; f.size.value = c.font.size; f.lh.value = c.font.lineHeight;
    f.ls.value = c.font.letterSpacing; f.weight.value = c.font.weight; f.bold.value = c.font.boldWeight; f.scrollSens.value = c.scrollSensitivity;
    f.cursor.value = c.cursor.style; f.blink.checked = c.cursor.blink; f.scrollback.value = c.scrollback;
    f.bgMode.value = c.bg.mode; f.dim.value = c.bg.dim; f.blur.value = c.bg.blur; f.speed.value = c.bg.speed; f.opacity.value = c.opacity;
    imgInfo.textContent = draft.bgImage ? `Imagen cargada · ${Math.round(draft.bgImage.length / 1024)} KB` : 'Sin imagen';
    f.shell.value = c.shell || ''; f.integ.checked = c.shellIntegration; f.restore.checked = c.restoreSession; f.inherit.checked = c.inheritCwd;
    f.copySel.checked = c.copyOnSelect; f.bell.checked = c.bell; f.flash.checked = c.bellFlash; f.confirmClose.checked = c.confirmClose;
    f.confirmPaste.checked = c.confirmPaste; f.notifyAfter.value = c.notifyAfter;
    f.provider.value = c.ai.provider; f.baseUrl.value = c.ai.baseUrl || ''; f.model.value = c.ai.model; f.key.value = '';
    f.key.placeholder = c.ai.hasKey ? '•••••••• (guardada — deja vacío para conservarla)' : 'sk-ant-…';
    showTab(tab);
    root.hidden = false;
  }
  function close() { capturing = null; root.hidden = true; document.documentElement.style.setProperty('--ui-scale', String(app.getConfig().ui.scale)); app.focusTerminal(); }
  async function save() {
    const c0 = app.getConfig();
    const n = (el, d) => (Number.isFinite(+el.value) && el.value !== '' ? +el.value : d);
    // La configuración se fusiona en profundidad: los atajos restablecidos se envían como null para quitarlos.
    const keysPatch = {};
    for (const a of ACTIONS) { if (isCustom(draft.keys, a.id)) keysPatch[a.id] = draft.keys[a.id]; else if (isCustom(c0.keys, a.id)) keysPatch[a.id] = null; }
    const win = { remember: f.winRemember.checked, w: n(f.winW, 1200), h: n(f.winH, 760) };
    const sizeChanged = win.w !== c0.window.w || win.h !== c0.window.h;
    await app.saveConfig({
      ui: { scale: n(f.uiScale, 1), tabs: f.tabsPos.value, style: f.uiStyle.value, glow: f.glow.checked, boot: f.boot.checked }, window: win,
      theme: f.theme.value,
      font: { family: f.family.value.trim() || undefined, size: n(f.size, 14), lineHeight: n(f.lh, 1.2), letterSpacing: n(f.ls, 0), weight: f.weight.value, boldWeight: f.bold.value },
      cursor: { style: f.cursor.value, blink: f.blink.checked },
      scrollback: n(f.scrollback, 10000), scrollSensitivity: n(f.scrollSens, 1),
      bg: { mode: f.bgMode.value, image: draft.bgImage, dim: n(f.dim, 0.82), blur: n(f.blur, 0), speed: n(f.speed, 1) }, opacity: n(f.opacity, 1),
      shell: f.shell.value.trim(), shellIntegration: f.integ.checked, restoreSession: f.restore.checked, inheritCwd: f.inherit.checked,
      copyOnSelect: f.copySel.checked, bell: f.bell.checked, bellFlash: f.flash.checked, confirmClose: f.confirmClose.checked,
      confirmPaste: f.confirmPaste.checked, notifyAfter: n(f.notifyAfter, 10),
      keys: keysPatch, profiles: draft.profiles.filter((p) => p.name.trim()),
      ai: { provider: f.provider.value, baseUrl: f.baseUrl.value.trim(), model: f.model.value.trim(), apiKey: f.key.value.trim() },
    });
    app.applyConfig();
    close();
    if (sizeChanged) app.setWindowSize?.(win.w, win.h);
    toast('Ajustes guardados');
  }
  return { open, close };
}
