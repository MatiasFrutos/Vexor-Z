export const defaults = {
  theme: 'Vexor Cyber',
  font: { family: '"JetBrainsMono Nerd Font","JetBrains Mono","Fira Code","DejaVu Sans Mono",monospace', size: 14, lineHeight: 1.2, letterSpacing: 0, weight: 'normal', boldWeight: 'bold' },
  cursor: { style: 'bar', blink: true },
  scrollback: 10000,
  shell: '',
  restoreSession: true,
  inheritCwd: true,
  copyOnSelect: false,
  bell: true,
  panelWidth: 400,
  opacity: 1,
  ui: { scale: 1, tabs: 'top', style: 'hud', glow: false, boot: true },
  bookmarks: [],
  httpHistory: [],
  window: { remember: true, w: 1200, h: 760 },
  vtabsWidth: 230,
  notes: '',
  bg: { mode: 'none', image: '', dim: 0.82, blur: 0, speed: 1 },
  scrollSensitivity: 1,
  shellIntegration: true,
  notifyAfter: 10,
  confirmClose: true,
  confirmPaste: true,
  bellFlash: true,
  keys: {},
  profiles: [],
  layouts: {},
  chat: [],
  session: null,
  ai: { provider: 'anthropic', baseUrl: '', model: 'claude-sonnet-5-5', hasKey: false },
  snippets: [
    { name: 'Git: estado corto', cmd: 'git status -sb' },
    { name: 'Docker: contenedores', cmd: 'docker ps -a' },
    { name: 'Puertos en escucha', cmd: 'ss -tulpn' },
    { name: 'Espacio en disco', cmd: 'df -h' },
    { name: 'Buscar texto en archivos', cmd: 'grep -rn "{{texto}}" .' },
  ],
  _home: '',
};

let transport;
let cfg = structuredClone(defaults);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  for (const [k, v] of Object.entries(b || {})) a[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return a;
}

export async function loadConfig(t) {
  transport = t;
  let stored = {};
  try { stored = await t.configGet(); } catch {}
  cfg = merge(structuredClone(defaults), stored);
  return cfg;
}
export const getConfig = () => cfg;

export async function saveConfig(patch) {
  patch = JSON.parse(JSON.stringify(patch)); // descarta undefined
  merge(cfg, patch);
  if (cfg.ai && 'apiKey' in cfg.ai) { if (cfg.ai.apiKey) cfg.ai.hasKey = true; delete cfg.ai.apiKey; }
  await transport.configSet(patch);
}
