// Hints por teclado (como los de Kitty/Alacritty): marca URLs, rutas, hashes, IPs… en pantalla y actúa sobre la elegida.
import { h, toast } from './ui.js';
import { cellGeometry } from './geo.js';

const PATTERNS = [
  ['url', /\bhttps?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]}]/g],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+\w/g],
  ['archivo:línea', /[\w.\-/]+\.[A-Za-z]{1,6}:\d+(?::\d+)?/g],
  ['ruta', /(?:~|\.{1,2})?\/(?:[\w.@+\-]+\/?)+/g],
  ['ip', /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g],
  ['hash', /\b[0-9a-f]{7,40}\b/g],
];
const ALPHABET = 'asdfghjklqwertyuiopzxcvbnm';

export function findHints(lines) {
  const found = [];
  lines.forEach((text, row) => {
    const taken = [];
    for (const [kind, re] of PATTERNS) {
      for (const m of text.matchAll(re)) {
        const s = m.index, e = s + m[0].length;
        if (kind === 'hash' && !(/\d/.test(m[0]) && /[a-f]/.test(m[0]))) continue;
        if (kind === 'ruta' && m[0].length < 3) continue;
        if (taken.some(([a, b]) => s < b && e > a)) continue;
        taken.push([s, e]);
        found.push({ kind, text: m[0], row, col: s });
      }
    }
  });
  found.sort((a, b) => a.row - b.row || a.col - b.col);
  return found;
}

export function makeLabels(n) {
  if (n <= ALPHABET.length) return [...ALPHABET].slice(0, n);
  const out = [];
  for (const a of ALPHABET) for (const b of ALPHABET) { out.push(a + b); if (out.length === n) return out; }
  return out;
}

export function createHints(app) {
  let st = null;

  function exit() {
    if (!st) return;
    removeEventListener('keydown', onKey, true);
    st.layer.remove();
    const p = st.pane; st = null;
    app.focusPane(p);
  }

  function act(hint, e) {
    exit();
    if (e.shiftKey) return app.insert(hint.text);
    if (e.ctrlKey && hint.kind === 'url') return app.openLink(hint.text);
    navigator.clipboard?.writeText(hint.text).then(() => toast(`Copiado: ${hint.text.length > 60 ? hint.text.slice(0, 57) + '…' : hint.text}`)).catch(() => toast('No se pudo copiar', 'error'));
  }

  function onKey(e) {
    if (!st || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.altKey || e.metaKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') return exit();
    if (e.key === 'Backspace') { st.typed = st.typed.slice(0, -1); return refresh(); }
    if (e.key.length !== 1) return;
    st.typed += e.key.toLowerCase();
    const cand = st.hints.filter((x) => x.label.startsWith(st.typed));
    if (!cand.length) { st.typed = st.typed.slice(0, -1); return; }
    const exact = cand.find((x) => x.label === st.typed);
    if (exact && cand.length === 1) return act(exact, e);
    refresh();
  }

  function refresh() {
    for (const x of st.hints) {
      const on = x.label.startsWith(st.typed);
      x.el.style.display = on ? '' : 'none';
      x.hl.style.display = on ? '' : 'none';
    }
  }

  function enter(pane) {
    if (st) return exit();
    const t = pane.term, b = t.buffer.active;
    const lines = [];
    for (let r = 0; r < t.rows; r++) lines.push(b.getLine(b.viewportY + r)?.translateToString(true) ?? '');
    const hints = findHints(lines);
    if (!hints.length) return toast('No hay nada que marcar en pantalla');
    const g = cellGeometry(pane); if (!g) return;
    const layer = h('div', { class: 'hints-layer' });
    const labels = makeLabels(hints.length);
    hints.forEach((x, i) => {
      x.label = labels[i];
      x.hl = h('div', { class: 'hint-hl', style: `left:${g.ox + x.col * g.w}px;top:${g.oy + x.row * g.h}px;width:${x.text.length * g.w}px;height:${g.h}px` });
      x.el = h('div', { class: 'hint-label', title: x.kind, style: `left:${g.ox + x.col * g.w}px;top:${g.oy + x.row * g.h}px;height:${g.h}px;line-height:${g.h}px` }, x.label);
      layer.append(x.hl, x.el);
    });
    layer.append(h('div', { class: 'hint-legend' }, 'letra: copiar · Mayús+letra: pegar en el prompt · Ctrl+letra: abrir URL · Esc: salir'));
    pane.el.append(layer);
    st = { pane, hints, layer, typed: '' };
    addEventListener('keydown', onKey, true);
  }

  return { enter, exit, get active() { return !!st; } };
}
