// Markdown mínimo y seguro (solo textContent): párrafos, listas, `código`, **negrita** y bloques ```.
import { h, icon } from './ui.js';

function inline(text) {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
    if (!part) continue;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) frag.append(h('code', {}, part.slice(1, -1)));
    else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) frag.append(h('strong', {}, part.slice(2, -2)));
    else frag.append(part);
  }
  return frag;
}

function codeBlock(code, lang, actions, streaming) {
  const shell = !lang || /^(bash|sh|shell|zsh|fish|console)$/i.test(lang);
  const bar = h('div', { class: 'code-head' }, h('span', { class: 'lang' }, lang || 'texto'), h('span', { class: 'spacer' }));
  const btn = (ic, label, fn) => h('button', { class: 'chip sm', title: label, onclick: fn }, icon(ic, 13), label);
  if (!streaming) {
    bar.append(btn('copy', 'Copiar', () => navigator.clipboard?.writeText(code)));
    if (shell && actions) {
      bar.append(btn('insert', 'Insertar', () => actions.insert(code)));
      bar.append(btn('play', 'Ejecutar', () => actions.run(code)));
    }
  }
  return h('div', { class: 'code' }, bar, h('pre', {}, code));
}

function block(text) {
  const out = document.createDocumentFragment();
  for (const para of text.split(/\n{2,}/)) {
    const lines = para.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) out.append(h('ul', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*[-*]\s+/, ''))))));
    else if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) out.append(h('ol', {}, lines.map((l) => h('li', {}, inline(l.replace(/^\s*\d+[.)]\s+/, ''))))));
    else {
      const p = h('p');
      lines.forEach((l, i) => { if (i) p.append(h('br')); p.append(inline(l.replace(/^#{1,4}\s+/, ''))); });
      out.append(p);
    }
  }
  return out;
}

export function renderMarkdown(text, el, actions, streaming = false) {
  el.replaceChildren();
  const parts = text.split('```');
  parts.forEach((part, i) => {
    if (i % 2 === 0) return el.append(block(part));
    const nl = part.indexOf('\n');
    const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
    const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
    const open = streaming && i === parts.length - 1; // bloque aún sin cerrar
    el.append(codeBlock(code, lang, actions, open));
  });
}
