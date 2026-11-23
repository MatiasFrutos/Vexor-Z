// Modo vi (copiar con teclado), como el de Alacritty: moverse por el historial, seleccionar y copiar.
import { h, toast } from './ui.js';
import { cellGeometry } from './geo.js';

const cls = (ch) => (ch === undefined || ch === ' ' ? 0 : /\w/.test(ch) ? 1 : 2);

export function createVi(app) {
  let st = null;

  const buf = () => st.pane.term.buffer.active;
  const text = (y) => buf().getLine(y)?.translateToString(true) ?? '';
  const lastY = () => buf().length - 1;

  function clamp() {
    st.cy = Math.max(0, Math.min(lastY(), st.cy));
    st.cx = Math.max(0, Math.min(st.pane.term.cols - 1, Math.min(st.cx, Math.max(0, text(st.cy).length - 1))));
  }

  function reveal() {
    const t = st.pane.term, vy = buf().viewportY;
    if (st.cy < vy) t.scrollToLine(st.cy);
    else if (st.cy >= vy + t.rows) t.scrollToLine(st.cy - t.rows + 1);
  }

  function select() {
    const t = st.pane.term;
    if (!st.mode) return;
    const a = st.anchor, c = { x: st.cx, y: st.cy };
    if (st.mode === 'V') return t.selectLines(Math.min(a.y, c.y), Math.max(a.y, c.y));
    const [s, e] = a.y < c.y || (a.y === c.y && a.x <= c.x) ? [a, c] : [c, a];
    t.select(s.x, s.y, (e.y - s.y) * t.cols + (e.x - s.x) + 1);
  }

  function draw() {
    clamp(); reveal(); select();
    const g = cellGeometry(st.pane); if (!g) return;
    const row = st.cy - buf().viewportY;
    Object.assign(st.cursor.style, { display: row >= 0 && row < st.pane.term.rows ? 'block' : 'none', width: `${g.w}px`, height: `${g.h}px`, left: `${g.ox + st.cx * g.w}px`, top: `${g.oy + row * g.h}px` });
    st.badge.textContent = st.mode === 'v' ? '-- VISUAL --' : st.mode === 'V' ? '-- VISUAL LÍNEA --' : '-- NORMAL --';
    app.onViChange?.(st);
  }

  function nextWord() {
    let { cx: x, cy: y } = st, t = text(y);
    const c0 = cls(t[x]);
    if (c0) while (x < t.length && cls(t[x]) === c0) x++;
    for (;;) {
      if (x >= t.length) { if (y >= lastY()) { x = Math.max(0, t.length - 1); break; } y++; t = text(y); x = 0; if (!t.length) break; }
      if (cls(t[x])) break;
      x++;
    }
    st.cx = x; st.cy = y;
  }
  function prevWord() {
    let { cx: x, cy: y } = st, t = text(y);
    x--;
    for (;;) {
      if (x < 0) { if (y <= 0) { x = 0; break; } y--; t = text(y); x = t.length - 1; if (x < 0) break; continue; }
      if (cls(t[x])) break;
      x--;
    }
    const c = cls(t[x]);
    while (x > 0 && cls(t[x - 1]) === c) x--;
    st.cx = Math.max(0, x); st.cy = y;
  }
  function endWord() {
    let { cx: x, cy: y } = st, t = text(y);
    x++;
    for (;;) {
      if (x >= t.length) { if (y >= lastY()) { x = Math.max(0, t.length - 1); break; } y++; t = text(y); x = 0; continue; }
      if (cls(t[x])) break;
      x++;
    }
    const c = cls(t[x]);
    while (x < t.length - 1 && cls(t[x + 1]) === c) x++;
    st.cx = x; st.cy = y;
  }

  function exit(msg) {
    if (!st) return;
    removeEventListener('keydown', onKey, true);
    st.pane.term.clearSelection();
    st.cursor.remove(); st.badge.remove();
    const p = st.pane; st = null;
    app.onViChange?.(null);
    if (msg) toast(msg);
    app.focusPane(p);
  }

  function yank(lines) {
    const t = st.pane.term;
    if (lines) { st.mode = 'V'; st.anchor = { x: 0, y: st.cy }; select(); }
    const sel = t.getSelection();
    if (!sel) return;
    navigator.clipboard?.writeText(sel).catch(() => {});
    exit(`Copiado (${sel.split('\n').length} línea${sel.includes('\n') ? 's' : ''})`);
  }

  function onKey(e) {
    if (!st || ['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.altKey || e.metaKey || (e.ctrlKey && e.shiftKey)) return; // deja pasar los atajos de la app
    const t = st.pane.term, k = e.key;
    e.preventDefault(); e.stopImmediatePropagation();
    const n = st.count || 1;
    const was = st.pending; st.pending = null;
    if (/^[1-9]$/.test(k) || (k === '0' && st.count)) { st.count = (st.count || 0) * 10 + Number(k); return; }
    st.count = 0;
    if (e.ctrlKey) {
      const half = Math.max(1, t.rows >> 1);
      if (k === 'u') st.cy -= half; else if (k === 'd') st.cy += half;
      else if (k === 'b') st.cy -= t.rows; else if (k === 'f') st.cy += t.rows;
      else if (k === 'c') return exit();
      return draw();
    }
    if (k === 'Escape' || k === 'q') { if (st.mode) { st.mode = null; t.clearSelection(); return draw(); } return exit(); }
    if (k === 'h' || k === 'ArrowLeft') st.cx -= n;
    else if (k === 'l' || k === 'ArrowRight') st.cx += n;
    else if (k === 'j' || k === 'ArrowDown') st.cy += n;
    else if (k === 'k' || k === 'ArrowUp') st.cy -= n;
    else if (k === '0' || k === 'Home') st.cx = 0;
    else if (k === '^') st.cx = Math.max(0, text(st.cy).search(/\S/));
    else if (k === '$' || k === 'End') st.cx = 1e6;
    else if (k === 'w') for (let i = 0; i < n; i++) nextWord();
    else if (k === 'b') for (let i = 0; i < n; i++) prevWord();
    else if (k === 'e') for (let i = 0; i < n; i++) endWord();
    else if (k === 'g') { if (was === 'g') st.cy = 0; else { st.pending = 'g'; return; } }
    else if (k === 'G') st.cy = lastY();
    else if (k === 'H') st.cy = buf().viewportY;
    else if (k === 'M') st.cy = buf().viewportY + (t.rows >> 1);
    else if (k === 'L') st.cy = buf().viewportY + t.rows - 1;
    else if (k === 'PageUp') st.cy -= t.rows; else if (k === 'PageDown') st.cy += t.rows;
    else if (k === 'v' || k === 'V') { const m = k; if (st.mode === m) { st.mode = null; t.clearSelection(); } else { if (!st.mode) st.anchor = { x: st.cx, y: st.cy }; st.mode = m; } }
    else if (k === 'y') return yank(false);
    else if (k === 'Y') return yank(true);
    else if (k === 'n' || k === 'N') {
      const q = app.lastFind?.();
      if (q) { app.findStep(q, k === 'n' ? 1 : -1); const pos = t.getSelectionPosition(); if (pos) { st.cx = pos.start.x; st.cy = pos.start.y; } }
    } else if (k === '/') { exit(); return app.openFind(); }
    draw();
  }

  function enter(pane) {
    if (st) return exit();
    const b = pane.term.buffer.active;
    const cursor = h('div', { class: 'vi-cursor' }), badge = h('div', { class: 'vi-badge' });
    pane.el.append(cursor, badge);
    st = { pane, cx: b.cursorX, cy: b.baseY + b.cursorY, mode: null, anchor: null, count: 0, pending: null, cursor, badge };
    addEventListener('keydown', onKey, true);
    draw();
  }

  return { enter, exit, get active() { return !!st; }, get pane() { return st?.pane; } };
}
