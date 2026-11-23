// Acciones y atajos configurables. Un atajo es una cadena como "Ctrl+Shift+T".
export const ACTIONS = [
  { id: 'newTab', name: 'Nueva pestaña', keys: ['Ctrl+Shift+T'] },
  { id: 'newWindow', name: 'Nueva ventana', keys: ['Ctrl+Shift+N'] },
  { id: 'splitRight', name: 'Dividir a la derecha', keys: ['Ctrl+Shift+D'] },
  { id: 'splitDown', name: 'Dividir abajo', keys: ['Ctrl+Shift+E'] },
  { id: 'closePane', name: 'Cerrar panel', keys: ['Ctrl+Shift+W'] },
  { id: 'zoomPane', name: 'Maximizar / restaurar panel', keys: ['Ctrl+Shift+Z'] },
  { id: 'nextPane', name: 'Panel siguiente', keys: ['Ctrl+Shift+]'] },
  { id: 'prevPane', name: 'Panel anterior', keys: ['Ctrl+Shift+['] },
  { id: 'nextTab', name: 'Pestaña siguiente', keys: ['Ctrl+Tab'] },
  { id: 'prevTab', name: 'Pestaña anterior', keys: ['Ctrl+Shift+Tab'] },
  { id: 'moveTabLeft', name: 'Mover pestaña a la izquierda', keys: ['Ctrl+Shift+PageUp'] },
  { id: 'moveTabRight', name: 'Mover pestaña a la derecha', keys: ['Ctrl+Shift+PageDown'] },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `goTab${i + 1}`, name: `Ir a la pestaña ${i + 1}`, keys: [`Alt+${i + 1}`] })),
  { id: 'broadcast', name: 'Broadcast a todos los paneles', keys: ['Ctrl+Shift+B'] },
  { id: 'find', name: 'Buscar en la terminal', keys: ['Ctrl+Shift+F'] },
  { id: 'viMode', name: 'Modo vi (copiar con teclado)', keys: ['Ctrl+Shift+Space'] },
  { id: 'hints', name: 'Hints: URLs, rutas, hashes, IPs', keys: ['Ctrl+Shift+H'] },
  { id: 'prevPrompt', name: 'Saltar al prompt anterior', keys: ['Ctrl+Shift+Up'] },
  { id: 'nextPrompt', name: 'Saltar al prompt siguiente', keys: ['Ctrl+Shift+Down'] },
  { id: 'aibar', name: 'Comando con IA', keys: ['Ctrl+Shift+K'] },
  { id: 'panelAi', name: 'Asistente IA', keys: ['Ctrl+Shift+A'] },
  { id: 'panelGit', name: 'Panel Git', keys: ['Ctrl+Shift+G'] },
  { id: 'panelDocker', name: 'Panel Docker', keys: ['Ctrl+Shift+O'] },
  { id: 'panelSnippets', name: 'Snippets', keys: ['Ctrl+Shift+S'] },
  { id: 'panelTools', name: 'Herramientas', keys: ['Ctrl+Shift+U'] },
  { id: 'panelFiles', name: 'Explorador de archivos', keys: ['Ctrl+Shift+J'] },
  { id: 'panelTasks', name: 'Tareas del proyecto', keys: ['Ctrl+Shift+M'] },
  { id: 'panelSystem', name: 'Procesos y puertos', keys: ['Ctrl+Shift+Y'] },
  { id: 'panelNotes', name: 'Notas', keys: ['Ctrl+Shift+Q'] },
  { id: 'panelApi', name: 'Cliente HTTP (API)', keys: ['Ctrl+Alt+A'] },
  { id: 'copyOutput', name: 'Copiar la salida del último comando', keys: ['Ctrl+Shift+X'] },
  { id: 'toggleSide', name: 'Mostrar / ocultar el panel lateral', keys: ['Ctrl+Shift+`'] },
  { id: 'history', name: 'Buscar en el historial de comandos', keys: ['Ctrl+Shift+R'] },
  { id: 'zen', name: 'Modo zen (ocultar barras)', keys: ['Ctrl+Shift+Enter'] },
  { id: 'fullscreen', name: 'Pantalla completa', keys: ['F11'] },
  { id: 'newWorkspace', name: 'Nuevo espacio de trabajo', keys: ['Ctrl+Alt+N'] },
  { id: 'nextWorkspace', name: 'Espacio de trabajo siguiente', keys: ['Ctrl+Alt+PageDown'] },
  { id: 'prevWorkspace', name: 'Espacio de trabajo anterior', keys: ['Ctrl+Alt+PageUp'] },
  ...Array.from({ length: 9 }, (_, i) => ({ id: `goWs${i + 1}`, name: `Ir al espacio de trabajo ${i + 1}`, keys: [`Ctrl+Alt+${i + 1}`] })),
  { id: 'uiUp', name: 'Agrandar la interfaz', keys: ['Ctrl+Alt+=', 'Ctrl+Alt+Num+'] },
  { id: 'uiDown', name: 'Reducir la interfaz', keys: ['Ctrl+Alt+-', 'Ctrl+Alt+Num-'] },
  { id: 'uiReset', name: 'Restablecer el tamaño de la interfaz', keys: ['Ctrl+Alt+0'] },
  { id: 'palette', name: 'Paleta de comandos', keys: ['Ctrl+Shift+P'] },
  { id: 'clear', name: 'Limpiar pantalla', keys: ['Ctrl+Shift+L'] },
  { id: 'settings', name: 'Ajustes', keys: ['Ctrl+,'] },
  { id: 'help', name: 'Atajos de teclado', keys: ['F1', 'Ctrl+Shift+/'] },
  { id: 'fontUp', name: 'Aumentar fuente', keys: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl+Num+'] },
  { id: 'fontDown', name: 'Reducir fuente', keys: ['Ctrl+-', 'Ctrl+Num-'] },
  { id: 'fontReset', name: 'Restablecer fuente', keys: ['Ctrl+0'] },
];

const CODE_MAP = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '=', Backquote: '`',
  Semicolon: ';', Quote: "'", Backslash: '\\', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num-',
};

function keyName(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  return CODE_MAP[c] || c;
}

export function comboFromEvent(e) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null;
  const m = [];
  if (e.ctrlKey) m.push('Ctrl');
  if (e.altKey) m.push('Alt');
  if (e.shiftKey) m.push('Shift');
  if (e.metaKey) m.push('Meta');
  m.push(keyName(e));
  return m.join('+');
}

const custom = (o, id) => o[id] !== undefined && o[id] !== null; // null/undefined = sin personalizar; '' = sin atajo

/** Mapa combinación → id de acción, aplicando las personalizaciones. */
export function buildBindings(overrides = {}) {
  const map = new Map();
  for (const a of ACTIONS) {
    const keys = custom(overrides, a.id) ? (overrides[a.id] ? [overrides[a.id]] : []) : a.keys;
    for (const k of keys) if (!map.has(k)) map.set(k, a.id);
  }
  return map;
}

export const isCustom = custom;
export const labelOf = (id, overrides = {}) => (custom(overrides, id) ? overrides[id] : ACTIONS.find((a) => a.id === id)?.keys[0]) || '';
export const defaultOf = (id) => ACTIONS.find((a) => a.id === id)?.keys[0] || '';
