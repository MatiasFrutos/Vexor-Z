import { h } from './ui.js';

const root = () => document.querySelector('#dialog');

function open(box, focusEl, onCancel) {
  const r = root();
  r.replaceChildren(box);
  r.hidden = false;
  r.onmousedown = (e) => { if (e.target === r) onCancel(); };
  focusEl?.focus();
}
const close = () => { const r = root(); r.hidden = true; r.replaceChildren(); r.onmousedown = null; };

/** Pide un texto. Devuelve el texto o null si se cancela. */
export function askInput({ title, placeholder = '', value = '', okLabel = 'Aceptar' }) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'field', placeholder, value, autocomplete: 'off', spellcheck: 'false' });
    const done = (v) => { close(); resolve(v); };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault(); // si no, la misma pulsación llega a la terminal al devolverle el foco
      done(e.key === 'Enter' ? input.value.trim() || null : null);
    });
    open(h('div', { class: 'modal small' },
      h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title)),
      h('div', { class: 'modal-body' }, input),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => done(null) }, 'Cancelar'), h('button', { class: 'btn primary', onclick: () => done(input.value.trim() || null) }, okLabel))),
    input, () => done(null));
    input.select();
  });
}

/** Pide confirmación. Devuelve true/false. */
export function confirmBox({ title, message, okLabel = 'Aceptar' }) {
  return new Promise((resolve) => {
    const ok = h('button', { class: 'btn primary', onclick: () => done(true) }, okLabel);
    const done = (v) => { close(); resolve(v); };
    const box = h('div', { class: 'modal small', tabindex: '-1' },
      h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title)),
      h('div', { class: 'modal-body' }, h('p', { class: 'confirm-msg' }, message)),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Cancelar'), ok));
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      done(e.key === 'Enter');
    });
    open(box, ok, () => done(false));
  });
}
