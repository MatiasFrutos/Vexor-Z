// Buscador del historial de comandos (como Ctrl+R pero con lista y filtro difuso).
import { h } from './ui.js';

const fuzzy = (q, s) => {
  q = q.toLowerCase(); s = s.toLowerCase();
  let i = 0, score = 0, last = -2;
  for (const ch of q) { const j = s.indexOf(ch, i); if (j < 0) return -1; score += j === last + 1 ? 3 : 1; last = j; i = j + 1; }
  return score - s.length * 0.005;
};

export function createHistory(app) {
  const root = document.querySelector('#history');
  const input = h('input', { id: 'history-input', placeholder: 'Buscar en el historial de comandos…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { id: 'history-list' });
  const foot = h('div', { class: 'aibar-foot' }, h('span', {}, h('kbd', {}, 'Enter'), ' insertar'), h('span', {}, h('kbd', {}, 'Mayús+Enter'), ' ejecutar'), h('span', {}, h('kbd', {}, 'Esc'), ' cerrar'));
  root.append(h('div', { class: 'box' }, input, list, foot));
  let all = [], items = [], sel = 0;

  function draw() {
    const q = input.value.trim();
    items = (q ? all.map((c) => [fuzzy(q, c), c]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c) : all).slice(0, 200);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((c, i) => {
      const li = h('li', { class: i === sel ? 'sel' : '' }, h('code', {}, c));
      li.addEventListener('click', () => pick(c, false));
      return li;
    }), ...(items.length ? [] : [h('li', { class: 'none' }, all.length ? 'Sin coincidencias' : 'No encuentro historial (bash: ~/.bash_history · zsh: ~/.zsh_history · fish)')]));
    list.children[sel]?.scrollIntoView?.({ block: 'nearest' });
  }
  function pick(cmd, run) { close(true); run ? app.run(cmd) : app.insert(cmd); }
  function close(skip) { root.hidden = true; if (!skip) app.focusTerminal(); }
  async function open() {
    root.hidden = false; input.value = ''; sel = 0; all = []; draw(); input.focus();
    all = await app.transport.history(3000); draw();
  }
  input.addEventListener('input', () => { sel = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowDown') { sel = Math.min(items.length - 1, sel + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel], e.shiftKey); }
  });
  root.addEventListener('mousedown', (e) => e.target === root && close());
  return { open, close, get active() { return !root.hidden; } };
}
