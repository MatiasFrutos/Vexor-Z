// "Comando con IA": describe lo que quieres hacer y se genera un único comando listo para insertar o ejecutar.
import { h } from './ui.js';

const FENCE = '```';
const SYSTEM = `Eres un generador de comandos de shell para Linux (Arch/Omarchy, bash). Responde SOLO con el comando dentro de un único bloque ${FENCE}bash, sin explicaciones. Usa una sola línea (encadena con && o pipes). Prefiere herramientas estándar.`;

export function extractCommand(text) {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)(```|$)/);
  return (m ? m[1] : text.replace(/```[a-zA-Z]*/g, '')).trim();
}

export function initAiBar(app) {
  const root = document.querySelector('#aibar');
  let id = 0, busy = false, ready = false, cmd = '';

  const input = h('input', { class: 'aibar-input', placeholder: 'Describe lo que quieres hacer… (p. ej. “archivos de más de 100 MB”)', autocomplete: 'off', spellcheck: 'false' });
  const result = h('pre', { class: 'aibar-result', hidden: true });
  const foot = h('div', { class: 'aibar-foot' });
  root.append(h('div', { class: 'box' }, input, result, foot));

  const hint = (...c) => foot.replaceChildren(...c.filter(Boolean));
  const keys = () => hint(h('span', {}, h('kbd', {}, 'Enter'), ' insertar'), h('span', {}, h('kbd', {}, 'Ctrl+Enter'), ' ejecutar'), h('span', {}, h('kbd', {}, 'Esc'), ' cerrar'));

  function reset() { ready = false; cmd = ''; result.hidden = true; result.textContent = ''; hint(h('span', {}, h('kbd', {}, 'Enter'), ' generar comando · ', h('kbd', {}, 'Esc'), ' cerrar')); }
  function open() { input.value = ''; reset(); root.hidden = false; input.focus(); }
  function close() { if (busy) app.transport.aiCancel(id); busy = false; root.hidden = true; app.focusTerminal(); }

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    const ctx = app.getContext(12);
    const content = `[cwd: ${ctx.cwd || '?'}${ctx.git ? ` · git: ${ctx.git.branch}` : ''}]\n${text}`;
    id = app.aiId(); busy = true; ready = false; cmd = '';
    result.hidden = false; result.textContent = '';
    hint(h('span', { class: 'thinking' }, 'Generando'));
    try { await app.transport.aiChat(id, { system: SYSTEM, messages: [{ role: 'user', content }] }); }
    catch (e) { fail(e.message || e); }
  }
  function fail(msg) { busy = false; result.hidden = true; hint(h('div', { class: 'err' }, String(msg))); }

  app.transport.onAi((ev) => {
    if (ev.id !== id || root.hidden) return;
    if (ev.kind === 'chunk') { cmd += ev.text; result.textContent = extractCommand(cmd); }
    else if (ev.kind === 'error') fail(ev.text);
    else if (ev.kind === 'done') {
      busy = false; cmd = extractCommand(cmd); result.textContent = cmd; ready = !!cmd;
      ready ? keys() : fail('La IA no devolvió ningún comando.');
    }
  });

  input.addEventListener('input', () => { if (!busy) reset(); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') return close();
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (ready) { const c = cmd; close(); e.ctrlKey ? app.run(c) : app.insert(c); }
    else submit();
  });
  root.addEventListener('mousedown', (e) => e.target === root && close());
  return { open, close };
}
