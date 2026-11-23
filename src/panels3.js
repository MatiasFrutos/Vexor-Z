// Cliente HTTP («API») y resumen del sistema con gráficas.
import { h, icon, toast } from './ui.js';

const errText = (e) => String(e?.message || e || 'error');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const fmtBytes = (n) => (n < 1024 ? `${Math.round(n)} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`);

/* ───────── Cliente HTTP ───────── */
export function parseHeaders(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && l.includes(':')).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }).filter(([k]) => k);
}
export function toCurl({ method, url, headers, body }) {
  const parts = ['curl', '-X', method, shq(url)];
  for (const [k, v] of headers) parts.push('-H', shq(`${k}: ${v}`));
  if (body) parts.push('--data-raw', shq(body));
  return parts.join(' ');
}
const pretty = (body) => { try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; } };

export function buildApiView(app) {
  const method = h('select', { class: 'field api-method', 'aria-label': 'Método' }, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => h('option', { value: m }, m)));
  const url = h('input', { class: 'field mono', placeholder: 'https://api.ejemplo.com/v1/recurso', 'aria-label': 'URL', spellcheck: 'false' });
  const headers = h('textarea', { class: 'field mono api-area', rows: '2', placeholder: 'Cabeceras, una por línea — Authorization: Bearer …', 'aria-label': 'Cabeceras', spellcheck: 'false' });
  const body = h('textarea', { class: 'field mono api-area', rows: '4', placeholder: 'Cuerpo (JSON, texto…)', 'aria-label': 'Cuerpo', spellcheck: 'false' });
  const sendBtn = h('button', { class: 'btn primary', onclick: () => send() }, icon('send', 15), 'Enviar');
  const out = h('div', { class: 'api-out' });
  let busy = false, last = null, tab = 'body';

  const current = () => ({ method: method.value, url: url.value.trim(), headers: parseHeaders(headers.value), body: ['GET', 'HEAD'].includes(method.value) ? '' : body.value });
  const load = (r) => { method.value = r.method; url.value = r.url; headers.value = (r.headers || []).map(([k, v]) => `${k}: ${v}`).join('\n'); body.value = r.body || ''; };

  function drawHistory() {
    const list = app.getConfig().httpHistory || [];
    out.replaceChildren(list.length ? h('div', { class: 'group' }, 'Recientes') : h('div', { class: 'empty small' }, h('div', { class: 'empty-title' }, 'Cliente HTTP'), 'Prueba tus APIs sin salir de la terminal. Escribe una URL y pulsa Enter.'),
      ...list.map((r) => h('button', { class: 'row', title: r.url, onclick: () => { load(r); url.focus(); } }, h('span', { class: `st m-${r.method}` }, r.method.slice(0, 3)), h('div', { class: 'row-main' }, h('div', { class: 'row-title mono' }, r.url)))));
  }

  function drawResponse() {
    const r = last;
    const cls = r.status < 300 ? 'is-ok' : r.status < 400 ? 'is-warn' : 'is-fail';
    const text = tab === 'body' ? pretty(r.body) : r.headers.map(([k, v]) => `${k}: ${v}`).join('\n');
    const seg = h('div', { class: 'seg2' }, ...[['body', 'Cuerpo'], ['headers', `Cabeceras (${r.headers.length})`]].map(([id, label]) => h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; drawResponse(); } }, label)));
    out.replaceChildren(...[
      h('div', { class: 'toolbar tight' }, h('span', { class: `pill status ${cls}` }, `${r.status} ${r.statusText}`), h('span', { class: 'hint' }, `${r.timeMs} ms · ${fmtBytes(r.size)}`), h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'Volver a recientes', onclick: () => { last = null; drawHistory(); } }, icon('history', 15))),
      h('div', { class: 'toolbar tight' }, seg, h('span', { class: 'spacer' }),
        h('button', { class: 'chip sm', onclick: () => { navigator.clipboard?.writeText(text); toast('Copiado'); } }, icon('copy', 13), 'Copiar'),
        h('button', { class: 'chip sm', title: 'Copia la petición como comando curl', onclick: () => { navigator.clipboard?.writeText(toCurl(r.req)); toast('curl copiado'); } }, icon('terminal', 13), 'curl'),
        h('button', { class: 'chip sm', title: 'Escribe el comando curl en la terminal', onclick: () => app.insert(toCurl(r.req)) }, icon('insert', 13), 'A la terminal')),
      h('pre', { class: 'api-body' }, text || '(sin contenido)'),
      r.truncated ? h('div', { class: 'hint' }, 'Respuesta recortada a 1 MB') : null,
    ].filter(Boolean));
  }

  async function send() {
    const req = current();
    if (!req.url || busy) return;
    if (!/^https?:\/\//i.test(req.url)) { req.url = `http://${req.url}`; url.value = req.url; }
    busy = true; sendBtn.disabled = true;
    out.replaceChildren(h('div', { class: 'empty small thinking' }, 'Enviando'));
    try {
      const r = await app.transport.http(req);
      last = { ...r, req }; tab = 'body'; drawResponse();
      const hist = [req, ...(app.getConfig().httpHistory || []).filter((x) => !(x.method === req.method && x.url === req.url))].slice(0, 12);
      app.saveConfig({ httpHistory: hist });
    } catch (e) { last = null; out.replaceChildren(h('div', { class: 'err api-err' }, errText(e))); }
    busy = false; sendBtn.disabled = false;
  }

  url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } else if (e.key === 'Escape') app.focusTerminal(); });
  for (const el of [headers, body]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); send(); } });
  const view = h('section', { class: 'view' },
    h('div', { class: 'api-form' }, h('div', { class: 'api-line' }, method, url, sendBtn), headers, body),
    h('div', { class: 'list api-list' }, out));
  drawHistory();
  return { view, show: () => { if (!last) drawHistory(); url.focus(); } };
}

/* ───────── Resumen del sistema ───────── */
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const gb = (b) => (b / 1073741824).toFixed(1);
const rate = (n) => `${fmtBytes(n)}/s`;
function fmtUptime(s) {
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`;
}
function drawSpark(canvas, data) {
  const w = canvas.clientWidth, hgt = canvas.clientHeight; if (!w || !hgt) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = w * dpr; canvas.height = hgt * dpr;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const n = 60, step = w / (n - 1), pts = data.slice(-n), off = n - pts.length;
  const y = (v) => hgt - 2 - (Math.min(100, Math.max(0, v)) / 100) * (hgt - 4);
  ctx.strokeStyle = css('--border'); ctx.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, hgt * f); ctx.lineTo(w, hgt * f); ctx.stroke(); }
  if (pts.length < 2) return;
  ctx.beginPath(); pts.forEach((v, i) => (i ? ctx.lineTo((off + i) * step, y(v)) : ctx.moveTo((off + i) * step, y(v))));
  ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(w, hgt); ctx.lineTo(off * step, hgt); ctx.closePath();
  ctx.globalAlpha = 0.14; ctx.fillStyle = css('--accent'); ctx.fill();
}

export async function renderOverview(app, box) {
  const { sys, hist } = app.getSys();
  if (!sys) { box.replaceChildren(h('div', { class: 'empty small' }, 'Leyendo el sistema…')); return; }
  const disks = await app.transport.disks();
  const bar = (pct) => h('div', { class: `meterbar${pct > 85 ? ' hot' : ''}` }, h('i', { style: `width:${Math.min(100, Math.round(pct))}%` }));
  const card = (label, value, ...extra) => h('div', { class: 'card' }, h('div', { class: 'card-label' }, label), h('div', { class: 'card-value' }, value), ...extra);
  const canvas = h('canvas', { class: 'spark', 'aria-label': 'Uso de CPU en los últimos minutos' });
  const memPct = sys.mem_total ? (sys.mem_used / sys.mem_total) * 100 : 0;
  box.replaceChildren(
    h('div', { class: 'cards' },
      h('div', { class: 'card wide' }, h('div', { class: 'card-label' }, 'CPU'), h('div', { class: 'card-value' }, `${Math.round(sys.cpu)} %`, h('small', {}, `carga ${sys.load.toFixed(2)}`)), canvas),
      card('Memoria', `${gb(sys.mem_used)} / ${gb(sys.mem_total)} GB`, bar(memPct)),
      card('Encendido', fmtUptime(sys.uptime || 0)),
      card('Red ↓', rate(hist.rx)), card('Red ↑', rate(hist.tx))),
    h('div', { class: 'group' }, 'Discos'),
    ...(disks.length ? disks.map((d) => h('div', { class: 'disk', title: d.fs }, h('div', { class: 'disk-top' }, h('span', { class: 'mono' }, d.mount), h('span', { class: 'hint' }, `${gb(d.used)} / ${gb(d.total)} GB · ${Math.round((d.used / d.total) * 100)} %`)), bar((d.used / d.total) * 100)))
      : [h('div', { class: 'empty small' }, 'No se pudieron leer los discos.')]),
  );
  drawSpark(canvas, hist.cpu);
}
