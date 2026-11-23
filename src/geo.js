// Geometría de celdas de un terminal (para superponer cursores, hints, etc.).
export function cellGeometry(pane) {
  const screen = pane.term.element?.querySelector('.xterm-screen');
  if (!screen) return null;
  const r = screen.getBoundingClientRect(), pr = pane.el.getBoundingClientRect();
  return { w: r.width / pane.term.cols, h: r.height / pane.term.rows, ox: r.left - pr.left, oy: r.top - pr.top };
}
