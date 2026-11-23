// Integración de shell (OSC 133) y notificaciones por secuencias OSC 9 / 777.
import { toast } from './ui.js';

export const fmtDuration = (s) => (s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`);

export function attachShellIntegration(pane, app) {
  const t = pane.term;
  pane.prompts = []; pane.last = null; pane.cmd = null; pane.curPrompt = null;

  function mark(marker, ec, dur) {
    if (!marker || marker.isDisposed) return;
    const deco = t.registerDecoration({ marker, x: 0, width: 1, height: 1 });
    // classList.add (no className=): hay que conservar la clase de xterm que posiciona la marca.
    deco?.onRender((el) => { el.classList.add('cmd-mark', ec === 0 ? 'is-ok' : 'is-fail'); el.title = `${ec === 0 ? 'OK' : `código ${ec}`} · ${fmtDuration(dur)}`; });
  }

  t.parser.registerOscHandler(133, (data) => {
    const [k, arg] = data.split(';');
    if (k === 'A') {
      const m = t.registerMarker(0);
      if (m) {
        pane.prompts.push(m); pane.curPrompt = m;
        m.onDispose(() => { const i = pane.prompts.indexOf(m); if (i >= 0) pane.prompts.splice(i, 1); });
        if (pane.prompts.length > 1000) pane.prompts.shift();
      }
    } else if (k === 'C') {
      pane.cmd = { start: performance.now(), prompt: pane.curPrompt, out: t.registerMarker(0) };
    } else if (k === 'D' && pane.cmd) {
      const ec = Number(arg) || 0, dur = (performance.now() - pane.cmd.start) / 1000;
      mark(pane.cmd.prompt, ec, dur);
      pane.last = { exit: ec, dur, at: Date.now() };
      pane.lastOut = { start: pane.cmd.out, end: t.registerMarker(0) };
      pane.cmd = null;
      app.onCommandDone(pane);
    }
    return true;
  });

  // Notificaciones desde programas: OSC 9;mensaje (iTerm2/Windows Terminal) y OSC 777;notify;título;cuerpo (urxvt/foot).
  t.parser.registerOscHandler(9, (d) => { if (!d.startsWith('4;')) app.notify('Vexor', d); return true; });
  t.parser.registerOscHandler(777, (d) => {
    const p = d.split(';');
    if (p[0] === 'notify') app.notify(p[1] || 'Vexor', p.slice(2).join(';'));
    return true;
  });
}

/** Salta al prompt anterior (-1) o siguiente (+1) respecto a lo que se ve en pantalla. */
export function jumpPrompt(pane, dir) {
  const t = pane.term, vy = t.buffer.active.viewportY;
  const lines = pane.prompts.filter((m) => !m.isDisposed && m.line >= 0).map((m) => m.line).sort((a, b) => a - b);
  if (dir < 0) {
    const c = lines.filter((l) => l < vy);
    if (c.length) t.scrollToLine(c[c.length - 1]); else toast('No hay prompts anteriores');
  } else {
    const c = lines.filter((l) => l > vy);
    if (c.length) t.scrollToLine(c[0]); else t.scrollToBottom();
  }
}

/** Texto que imprimió el último comando terminado (requiere la integración de shell). null si no se conoce. */
export function lastOutput(pane) {
  const o = pane.lastOut;
  if (!o?.start || !o.end || o.start.isDisposed || o.end.isDisposed || o.start.line < 0) return null;
  const b = pane.term.buffer.active, out = [];
  for (let y = o.start.line; y < o.end.line; y++) {
    const line = b.getLine(y); if (!line) break;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text; else out.push(text);
  }
  return out.join('\n').replace(/\s+$/, '');
}
