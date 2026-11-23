// Pruebas end-to-end de Vexor (modo navegador). Ver run.sh.
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; fails.push(name); console.log('  ✗', name, detail); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = String.raw;
const ROOT = process.env.E2E_ROOT || '/home/user/Vexor';
const TMPD = process.env.E2E_TMP;

/* PNG mínimo sólido (para probar imágenes y fondos) */
const crcT = [...Array(256)].map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 1, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text()));
  const URL = 'http://127.0.0.1:4173/?renderer=dom';

  const buf = (which = 'active') => page.evaluate((w) => {
    const t = window.vexor.active(); const p = w === 'active' ? t.focus : [...window.vexor.panes.values()][w];
    const bb = p.term.buffer.active; let s = ''; for (let i = 0; i < bb.length; i++) s += (bb.getLine(i)?.translateToString(true) ?? '') + '\n'; return s;
  }, which);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  // Texto visible sin transformaciones de CSS (el estilo futurista pone rótulos en mayúsculas).
  const txt = (sel) => page.evaluate((q) => {
    const root = document.querySelector(q); if (!root) throw new Error('no existe ' + q);
    const out = [];
    (function walk(n) {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      const cs = getComputedStyle(n); if (cs.display === 'none' || cs.visibility === 'hidden') return;
      for (const c of n.childNodes) walk(c);
      if (!cs.display.startsWith('inline')) out.push('\n');
    })(root);
    return out.join('');
  }, sel);
  const waitFor = async (fn, ms = 8000, step = 150) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; };
  const type = async (t) => { await page.keyboard.type(t, { delay: 3 }); await page.keyboard.press('Enter'); };
  const state = () => ev(() => ({ tabs: window.vexor.tabs().length, panes: window.vexor.panes.size, side: !document.querySelector('#side').hidden }));
  const sh = (key) => page.keyboard.press(key);
  const clip = () => ev(() => navigator.clipboard.readText());
  const activePane = (fn) => ev(`(() => { const p = window.vexor.active().focus; return (${fn})(p); })()`);
  const notes = async () => (await fetch('http://127.0.0.1:4173/__notifications')).json();
  const focusTerm = () => page.click('.tabview.active .pane.focused .xterm');
  const palette = async (q) => { await sh('Control+Shift+P'); await sleep(200); await page.keyboard.type(q, { delay: 8 }); await sleep(150); await sh('Enter'); };

  console.log('\n[1] Arranque y terminal');
  const t0 = Date.now();
  await page.goto(URL);
  await waitFor(async () => (await buf()).includes('❯'), 10000, 50);
  const startupMs = Date.now() - t0;
  let st = await state();
  ok('arranca con 1 pestaña y 1 panel', st.tabs === 1 && st.panes === 1, JSON.stringify(st));
  await page.click('.pane'); await type('echo hello-$((40+2))');
  ok('el shell responde (PTY real)', await waitFor(async () => (await buf()).includes('hello-42')));
  ok('barra de estado muestra cwd', await waitFor(async () => (await txt('#status')).includes(ROOT)));
  ok('barra de estado muestra rama git', await waitFor(async () => (await txt('#status')).match(/ccr-|main|vexor/i)));
  ok('barra de estado muestra CPU y RAM', await waitFor(async () => { const t = await txt('#status'); return t.includes('CPU') && t.includes('RAM'); }));

  console.log('\n[2] Pestañas y splits (heredan el directorio)');
  await type('cd /tmp');
  await waitFor(async () => (await activePane('p => p.cwd')) === '/tmp');
  await sh('Control+Shift+T'); await sleep(900);
  ok('nueva pestaña (2 pestañas)', (await state()).tabs === 2);
  ok('nueva pestaña hereda el cwd', await waitFor(async () => (await activePane('p => p.cwd')) === '/tmp'));
  await sh('Control+Shift+D'); await sleep(900);
  ok('split derecha (3 paneles en total)', (await state()).panes === 3);
  ok('split hereda el cwd', await waitFor(async () => (await activePane('p => p.cwd')) === '/tmp'));
  await sh('Control+Shift+E'); await sleep(700);
  ok('split abajo (4 paneles en total)', (await state()).panes === 4);
  await sh('Control+Shift+W'); await sleep(500);
  ok('cerrar panel', (await state()).panes === 3);
  await sh('Control+Shift+Z'); await sleep(400);
  ok('maximizar panel (1 visible)', (await ev(() => document.querySelectorAll('.tabview.active .pane').length)) === 1);
  ok('badge MAXIMIZADO', (await txt('#status')).includes('MAXIMIZADO'));
  await sh('Control+Shift+Z'); await sleep(400);
  ok('restaurar panel (2 visibles)', (await ev(() => document.querySelectorAll('.tabview.active .pane').length)) === 2);

  console.log('\n[3] Broadcast');
  await sh('Control+Shift+B'); await sleep(200);
  await type('echo bc-$((1+1))'); await sleep(900);
  ok('broadcast escribe en ambos paneles', (await buf(1)).includes('bc-2') && (await buf(2)).includes('bc-2'));
  await sh('Control+Shift+B');

  console.log('\n[4] Renombrar y reordenar pestañas');
  await page.dblclick('.tab.active .name'); await page.keyboard.type('Servidor'); await sh('Enter'); await sleep(200);
  ok('renombrar pestaña (doble clic)', (await txt('#tabs')).includes('Servidor'));
  const before = await page.$$eval('#tabs .tab .name', (e) => e.map((x) => x.textContent));
  await page.locator('#tabs .tab').nth(1).dragTo(page.locator('#tabs .tab').nth(0)); await sleep(300);
  const after = await page.$$eval('#tabs .tab .name', (e) => e.map((x) => x.textContent));
  ok('reordenar pestañas con arrastrar', before[0] === after[1] && before[1] === after[0], JSON.stringify({ before, after }));

  console.log('\n[5] Búsqueda');
  await focusTerm(); await type('echo needle-xyz'); await sleep(400);
  await sh('Control+Shift+F'); await page.keyboard.type('needle-xyz'); await sleep(500);
  ok('barra de búsqueda visible', await page.isVisible('#findbar'));
  ok('contador de resultados', await waitFor(async () => /\d+\/\d+/.test(await txt('#find-count'))), await txt('#find-count'));
  await sh('Escape'); await sleep(200);
  ok('Esc cierra la búsqueda', !(await page.isVisible('#findbar')));

  console.log('\n[6] Paleta, temas y ajustes');
  await palette('nord'); await sleep(400);
  ok('paleta: cambia a tema Nord', (await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#88c0d0');
  await sh('Control+Comma'); await sleep(300);
  ok('ajustes se abren (con pestañas)', (await page.isVisible('#settings .modal')) && (await page.$$('#settings .set-tab')).length === 7);
  await page.click('#settings .set-tab[data-tab="appearance"]'); await sleep(150);
  await page.locator('#settings .tabpane:not([hidden]) input[type=number]').nth(0).fill('18');
  await page.click('#settings .btn.primary'); await sleep(500);
  ok('ajustes aplican el tamaño de fuente', (await activePane('p => p.term.options.fontSize')) === 18);
  ok('ajustes: modal se cierra', !(await page.isVisible('#settings .modal')));
  await sh('Control+0'); await sleep(200);
  ok('Ctrl+0 restablece la fuente a 14', (await activePane('p => p.term.options.fontSize')) === 14);

  console.log('\n[7] Asistente IA (servidor simulado)');
  await sh('Control+Shift+A'); await sleep(400);
  ok('panel IA abierto', (await state()).side);
  await page.click('.ai-quick .chip:has-text("Explicar error")');
  ok('IA responde con streaming', await waitFor(async () => (await txt('.ai-log')).includes('vexor-core')));
  await waitFor(async () => (await page.$$('.ai-log .code')).length > 0);
  ok('bloque de código con acciones', (await page.$$('.ai-log .code .chip')).length >= 3);
  await page.click('.ai-log .code .chip:has-text("Insertar")'); await sleep(500);
  ok('Insertar escribe el comando en la terminal', (await buf()).includes('cargo add vexor-core'));
  await sh('Control+u');
  await page.uncheck('.ai-foot input[type=checkbox]');
  await page.fill('.ai-text', 'comprimir esta carpeta'); await sh('Enter');
  ok('segunda pregunta funciona', await waitFor(async () => (await txt('.ai-log')).includes('backup.tar.gz')));

  console.log('\n[8] Comando con IA (Ctrl+Shift+K)');
  await focusTerm();
  await sh('Control+Shift+K'); await sleep(300);
  ok('barra de IA visible', await page.isVisible('#aibar .box'));
  await page.keyboard.type('archivos de mas de 100MB'); await sh('Enter');
  ok('genera un comando', await waitFor(async () => (await txt('.aibar-result')).includes('find . -size +100M')));
  await waitFor(async () => (await txt('.aibar-foot')).includes('insertar'));
  await sh('Enter'); await sleep(500);
  ok('Enter inserta el comando', (await buf()).includes('find . -size +100M'));
  ok('la barra se cierra', !(await page.isVisible('#aibar .box')));
  await sh('Control+u');

  console.log('\n[9] Snippets');
  await sh('Control+Shift+S'); await sleep(400);
  const n0 = (await page.$$('#side .row')).length;
  await page.fill('#side .form input:nth-child(1)', 'Hola'); await page.fill('#side .form input:nth-child(2)', 'echo snippet-ok');
  await page.click('#side .form .btn'); await sleep(500);
  ok('añadir snippet', (await page.$$('#side .row')).length === n0 + 1);
  await page.locator('#side .row', { hasText: 'Hola' }).hover();
  await page.locator('#side .row', { hasText: 'Hola' }).locator('button[title="Ejecutar"]').click(); await sleep(700);
  ok('ejecutar snippet', (await buf()).includes('snippet-ok'));
  await page.locator('#side .row', { hasText: 'Hola' }).hover();
  await page.locator('#side .row', { hasText: 'Hola' }).locator('button[title="Eliminar"]').click(); await sleep(400);
  ok('eliminar snippet', (await page.$$('#side .row')).length === n0);

  console.log('\n[10] Herramientas');
  await sh('Control+Shift+U'); await sleep(700);
  const toolsText = await txt('#side');
  ok('lista de herramientas con detección', toolsText.includes('Node REPL') && toolsText.includes('no instalado'));
  const t1 = (await state()).tabs;
  await page.locator('#side .row', { hasText: 'Node REPL' }).click(); await sleep(2500);
  ok('abre la herramienta en nueva pestaña', (await state()).tabs === t1 + 1);
  ok('la herramienta se ejecuta (node REPL)', await waitFor(async () => (await buf()).includes('Welcome to Node')));
  await sh('Control+d'); await sh('Control+d'); await sleep(800);

  console.log('\n[11] Git');
  await focusTerm(); await type(`cd ${ROOT}`);
  await waitFor(async () => (await activePane('p => p.cwd')) === ROOT);
  await sh('Control+Shift+G'); await sleep(1500);
  const gitText = await txt('#side');
  ok('muestra la rama', /ccr-|main|vexor/i.test(gitText), gitText.slice(0, 120));
  ok('lista commits', /últimos commits/i.test(gitText) && (await page.$$('#side .view:not([hidden]) .hash')).length >= 2);
  ok('lista cambios', /cambios \(/i.test(gitText));

  console.log('\n[12] Docker (docker simulado)');
  await sh('Control+Shift+O'); await sleep(1500);
  ok('lista contenedores', (await txt('#side')).includes('web-api') && (await txt('#side')).includes('redis-cache'));
  ok('resumen en ejecución', (await txt('#side')).includes('2/3'));
  await page.locator('#side .row', { hasText: 'web-api' }).hover();
  await page.locator('#side .row', { hasText: 'web-api' }).locator('button[title="Detener"]').click(); await sleep(1500);
  ok('detener contenedor actualiza el estado', (await txt('#side')).includes('1/3'));
  await page.locator('#side .row', { hasText: 'redis-cache' }).hover();
  await page.locator('#side .row', { hasText: 'redis-cache' }).locator('button[title="Iniciar"]').click(); await sleep(1500);
  ok('iniciar contenedor actualiza el estado', (await txt('#side')).includes('2/3'));

  console.log('\n[13] Panel lateral: ancho ajustable');
  const w0 = await ev(() => document.querySelector('#side').getBoundingClientRect().width);
  const grip = await page.locator('.side-resize').boundingBox();
  await page.mouse.move(grip.x + 2, grip.y + 200); await page.mouse.down(); await page.mouse.move(grip.x - 120, grip.y + 200, { steps: 6 }); await page.mouse.up(); await sleep(300);
  const w1 = await ev(() => document.querySelector('#side').getBoundingClientRect().width);
  ok('arrastrar cambia el ancho', w1 > w0 + 80, `${w0} → ${w1}`);
  await sh('Control+Shift+O'); await sleep(300);
  ok('cerrar panel lateral', !(await state()).side);

  console.log('\n[14] Menú contextual y ayuda');
  const pn = await page.locator('.tabview.active .pane.focused').boundingBox();
  await page.mouse.click(pn.x + 200, pn.y + 120, { button: 'right' }); await sleep(300);
  ok('menú contextual visible', await page.isVisible('.ctx'));
  const ctxText = await txt('.ctx');
  ok('menú con acciones nuevas (vi, hints, pager)', ['Dividir a la derecha', 'Modo vi', 'Hints', 'pager', 'Exportar historial'].every((x) => ctxText.includes(x)));
  const pc = (await state()).panes;
  await page.click('.ctx-item:has-text("Dividir a la derecha")'); await sleep(900);
  ok('acción del menú contextual (split)', (await state()).panes === pc + 1);
  await sh('F1'); await sleep(300);
  ok('ayuda de atajos (F1)', (await page.isVisible('#help .modal')) && (await txt('#help')).includes('Comando con IA') && (await txt('#help')).includes('Modo vi'));
  await sh('Escape'); await sleep(200);
  ok('Esc cierra la ayuda', !(await page.isVisible('#help .modal')));

  console.log('\n[15] Portapapeles / historial');
  await palette('copiar todo');  await sleep(500);
  ok('copiar historial al portapapeles', (await clip()).length > 10);

  console.log('\n[16] Campana en pestaña inactiva');
  await focusTerm();
  await type("(sleep 2; printf '\\a') &"); await sleep(200);
  const other = (await ev(() => window.vexor.tabs().indexOf(window.vexor.active()))) === 0 ? 1 : 0;
  await page.locator('#tabs .tab').nth(other).click(); await sleep(2800);
  ok('punto de aviso en la pestaña inactiva', (await page.$$('#tabs .tab .dot')).length >= 1);

  console.log('\n[17] Rendimiento con salida grande');
  await page.locator('#tabs .tab').nth(0).click(); await sleep(500);
  await focusTerm();
  const t2 = Date.now(); await type('seq 1 300000; echo FIN-$((1+1))');
  const fin = await waitFor(async () => (await buf()).includes('FIN-2'), 20000, 100);
  const bulkMs = Date.now() - t2;
  ok(`300 000 líneas procesadas (${bulkMs} ms)`, fin && bulkMs < 15000);
  await sh('Control+Shift+L');

  console.log('\n[18] Restaurar sesión');
  await ev(() => window.vexor.saveSession()); await sleep(800);
  const nTabs = (await state()).tabs;
  await page.reload(); await sleep(2500);
  st = await state();
  ok(`tras recargar se restauran las ${nTabs} pestañas`, st.tabs === nTabs, JSON.stringify(st));
  ok('se conserva el nombre de pestaña', (await txt('#tabs')).includes('Servidor'));
  ok('se conserva el tema', (await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#88c0d0');
  await sh('Control+Shift+A'); await sleep(500);
  ok('el historial de IA persiste', (await txt('.ai-log')).includes('backup.tar.gz'));
  await sh('Control+Shift+A');

  // A partir de aquí, sesión limpia
  await ev(() => window.vexor.setConfig({ restoreSession: false }));
  await page.reload(); await waitFor(async () => (await buf()).includes('❯'), 10000);
  await page.click('.pane');
  st = await state();
  ok('sesión limpia (1 pestaña)', st.tabs === 1);

  console.log('\n[20] Integración de shell (OSC 133 real desde bash)');
  ok('el shell emite marcas de prompt', await waitFor(async () => (await activePane('p => p.prompts.length')) >= 1));
  await type('true');
  ok('registra el código de salida 0', await waitFor(async () => (await activePane('p => p.last && p.last.exit')) === 0));
  ok('marca verde junto al prompt', await waitFor(async () => (await page.$$('.cmd-mark.is-ok')).length >= 1));
  await type('false');
  ok('registra el código de salida 1', await waitFor(async () => (await activePane('p => p.last && p.last.exit')) === 1));
  ok('marca roja junto al prompt', await waitFor(async () => (await page.$$('.cmd-mark.is-fail')).length >= 1));
  ok('barra de estado muestra ✗ 1', await waitFor(async () => /✗ 1/.test(await txt('#status'))));
  await type('sleep 1.3');
  ok('mide la duración del comando', await waitFor(async () => (await activePane('p => p.last && p.last.dur')) >= 1.2, 5000));
  await type('seq 1 400');
  await waitFor(async () => (await buf()).split('\n').includes('400'));
  await sleep(400);
  const vy0 = await activePane('p => p.term.buffer.active.viewportY');
  await sh('Control+Shift+ArrowUp'); await sleep(300);
  const vy1 = await activePane('p => p.term.buffer.active.viewportY');
  ok('saltar al prompt anterior (Ctrl+Shift+↑)', vy1 < vy0, `${vy0} → ${vy1}`);
  await sh('Control+Shift+ArrowDown'); await sleep(300);
  ok('saltar al prompt siguiente (Ctrl+Shift+↓)', (await activePane('p => p.term.buffer.active.viewportY')) > vy1);
  await ev(() => window.vexor.setConfig({ notifyAfter: 1 }));
  await type('sleep 2');
  await sh('Control+Shift+T'); await sleep(900);
  ok('notifica un comando largo terminado en otra pestaña', await waitFor(async () => (await notes()).some((n) => n.title === 'Comando terminado'), 6000));
  await sh('Alt+1'); await sleep(400);
  await focusTerm();
  await type(R`printf '\e]9;hola-osc9\a'`);
  ok('OSC 9 genera una notificación', await waitFor(async () => (await notes()).some((n) => n.body === 'hola-osc9')));
  await type(R`printf '\e]777;notify;Titulo777;Cuerpo777\a'`);
  ok('OSC 777 genera una notificación', await waitFor(async () => (await notes()).some((n) => n.title === 'Titulo777' && n.body === 'Cuerpo777')));
  await ev(() => window.vexor.setConfig({ notifyAfter: 10 }));
  await type('sleep 30');
  ok('detecta el proceso en primer plano', await waitFor(async () => (await activePane('p => p.fg')) === 'sleep', 6000));
  ok('barra de estado muestra ▶ sleep', await waitFor(async () => (await txt('#status')).includes('▶ sleep')));
  await sh('Control+Shift+W'); await sleep(500);
  ok('pide confirmación al cerrar con un proceso en marcha', (await page.isVisible('#dialog .modal')) && (await txt('#dialog')).includes('sleep'));
  await sh('Escape'); await sleep(300);
  ok('cancelar conserva la pestaña', !(await page.isVisible('#dialog .modal')) && (await state()).tabs === 2);
  await focusTerm(); await sh('Control+c');
  ok('al terminar el proceso desaparece ▶', await waitFor(async () => (await activePane('p => p.fg')) === null, 5000));

  console.log('\n[21] Modo vi');
  await type('echo "alpha beta gamma"'); await sleep(500);
  await sh('Control+Shift+Space'); await sleep(250);
  ok('entra en modo vi (cursor y badge)', (await page.isVisible('.vi-cursor')) && (await txt('.vi-badge')).includes('NORMAL'));
  ok('badge VI en la barra de estado', (await txt('#status')).includes('VI'));
  await page.keyboard.press('k'); await page.keyboard.press('0'); await page.keyboard.press('v'); await page.keyboard.press('e'); await sleep(150);
  ok('modo visual selecciona', (await activePane('p => p.term.getSelection()')) === 'alpha');
  await page.keyboard.press('y'); await sleep(300);
  ok('y copia la selección y sale', (await clip()) === 'alpha' && !(await page.isVisible('.vi-cursor')));
  await sh('Control+Shift+Space'); await sleep(200);
  for (const k of ['k', '0', 'w', 'v', '$']) await page.keyboard.press(k);
  await page.keyboard.press('y'); await sleep(300);
  ok('w, $ y selección de varias palabras', (await clip()) === 'beta gamma', await clip());
  await sh('Control+Shift+Space'); await sleep(200);
  await page.keyboard.press('k'); await page.keyboard.press('V'); await page.keyboard.press('y'); await sleep(300);
  ok('V + y copia la línea', (await clip()).includes('alpha beta gamma'));
  await sh('Control+Shift+Space'); await sleep(200);
  await page.keyboard.press('g'); await page.keyboard.press('g'); await sleep(250);
  ok('gg va al principio del historial', (await activePane('p => p.term.buffer.active.viewportY')) === 0);
  await page.keyboard.press('G'); await sleep(250);
  ok('G va al final', (await activePane('p => p.term.buffer.active.viewportY')) > 0);
  await page.keyboard.press('Escape'); await sleep(200);
  ok('Esc sale del modo vi', !(await page.isVisible('.vi-cursor')) && !(await txt('#status')).includes('VI'));

  console.log('\n[22] Hints por teclado');
  await type('echo https://example.com/a?b=1 /etc/hosts 192.168.1.10 deadbeef12 src/main.js:42'); await sleep(500);
  await sh('Control+Shift+H'); await sleep(300);
  const nh = (await page.$$('.hint-label')).length;
  ok(`marca URLs, rutas, IPs, hashes y archivo:línea (${nh})`, nh >= 5);
  await page.keyboard.press('a'); await sleep(300);
  ok('letra copia el texto', (await clip()) === 'https://example.com/a?b=1', await clip());
  ok('los hints se cierran', (await page.$$('.hint-layer, .hints-layer')).length === 0);
  await sh('Control+Shift+H'); await sleep(250); await page.keyboard.press('Shift+A'); await sleep(300);
  ok('Mayús+letra pega en el prompt', (await buf()).trimEnd().split('\n').pop().includes('https://example.com/a?b=1'));
  await sh('Control+u');
  await sh('Control+Shift+H'); await sleep(250);
  await ev(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  await page.keyboard.press('Control+a'); await sleep(300);
  ok('Ctrl+letra abre la URL', (await ev(() => window.__opened)).includes('https://example.com/a?b=1'), JSON.stringify(await ev(() => window.__opened)));
  await sh('Control+Shift+H'); await sleep(200); await sh('Escape'); await sleep(200);
  ok('Esc cancela los hints', (await page.$$('.hints-layer')).length === 0);

  console.log('\n[23] Imágenes (iTerm inline y Sixel) y Unicode');
  const img = png(16, 16, [220, 40, 40]), b64 = img.toString('base64');
  await sh('Control+Shift+T'); await sleep(900); await focusTerm();
  const c0 = await activePane('p => p.el.querySelectorAll("canvas").length');
  await type(`printf '\\e]1337;File=inline=1;size=${img.length};width=4;height=2:${b64}\\a'`);
  ok('imagen inline (iTerm / imgcat)', await waitFor(async () => (await activePane('p => p.el.querySelectorAll("canvas").length')) > c0, 5000));
  await sh('Control+Shift+T'); await sleep(900); await focusTerm();
  const c1 = await activePane('p => p.el.querySelectorAll("canvas").length');
  await type(`printf '\\ePq"1;1;16;12#0;2;100;0;0#0!16~-!16~\\e\\\\'`);
  ok('imagen Sixel', await waitFor(async () => (await activePane('p => p.el.querySelectorAll("canvas").length')) > c1, 5000));
  ok('Unicode 11 activo (anchos de emoji/CJK)', (await activePane('p => p.term.unicode.activeVersion')) === '11');
  await type(R`printf '\e]8;;https://example.org/osc8\e\\texto-enlace\e]8;;\e\\\n'`); await sleep(500);
  await ev(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
  const lb = await page.locator('.tabview.active .xterm-rows').getByText('texto-enlace').last().boundingBox();
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2); await sleep(300);
  await page.keyboard.down('Control'); await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2); await page.keyboard.up('Control'); await sleep(400);
  ok('hipervínculo OSC 8 con Ctrl+clic', (await ev(() => window.__opened)).includes('https://example.org/osc8'), JSON.stringify(await ev(() => window.__opened)));
  await page.mouse.click(lb.x + lb.width / 2, lb.y + lb.height / 2); await sleep(300);
  ok('sin Ctrl el clic no abre el enlace', (await ev(() => window.__opened)).length === 1);

  console.log('\n[24] Atajos configurables');
  const tk = (await state()).tabs;
  await ev(() => window.vexor.setConfig({ keys: { newTab: 'Ctrl+Alt+T' } }));
  await sh('Control+Shift+T'); await sleep(500);
  ok('el atajo antiguo deja de funcionar', (await state()).tabs === tk);
  await sh('Control+Alt+T'); await sleep(700);
  ok('el atajo nuevo funciona', (await state()).tabs === tk + 1);
  await ev(() => window.vexor.setConfig({ keys: { newTab: null } }));
  await sh('Control+Shift+T'); await sleep(700);
  ok('restablecer devuelve el atajo original', (await state()).tabs === tk + 2);
  await sh('Control+Comma'); await sleep(300);
  await page.click('#settings .set-tab[data-tab="keys"]'); await sleep(200);
  ok('editor de atajos lista todas las acciones', (await page.$$('#settings .key-row')).length > 30);
  await page.locator('#settings .key-row').first().locator('.keybtn').click();
  await page.keyboard.press('Control+Alt+J'); await sleep(150);
  ok('captura la nueva combinación', (await page.locator('#settings .key-row').first().innerText()).includes('Ctrl+Alt+J'));
  await page.click('#settings .btn.primary'); await sleep(500);
  const tk2 = (await state()).tabs;
  await sh('Control+Alt+J'); await sleep(700);
  ok('el atajo guardado desde Ajustes funciona', (await state()).tabs === tk2 + 1);
  await sh('Control+Comma'); await sleep(300);
  await page.click('#settings .set-tab[data-tab="keys"]'); await sleep(200);
  await page.locator('#settings .key-row').first().locator('.link').click(); await sleep(150);
  await page.click('#settings .btn.primary'); await sleep(500);
  const tk3 = (await state()).tabs;
  await sh('Control+Alt+J'); await sleep(400);
  ok('Restablecer + Guardar quita la personalización', (await state()).tabs === tk3);

  console.log('\n[25] Fondos, animaciones y transparencia');
  const modes = ['matrix', 'stars', 'network', 'gradient'];
  for (const m of modes) {
    await ev((mode) => window.vexor.setConfig({ bg: { mode } }), m); await sleep(1300);
    const info = await ev(() => { const c = document.querySelector('.bg-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const first = [d[0], d[1], d[2]]; let diff = 0; for (let i = 0; i < d.length; i += 4 * 37) if (Math.abs(d[i] - first[0]) + Math.abs(d[i + 1] - first[1]) + Math.abs(d[i + 2] - first[2]) > 12) diff++; return { shown: getComputedStyle(c).display !== 'none', diff }; });
    ok(`fondo animado “${m}” dibuja`, info.shown && info.diff > 3, JSON.stringify(info));
  }
  const frameA = await ev(() => document.querySelector('.bg-canvas').toDataURL()); await sleep(600);
  const frameB = await ev(() => document.querySelector('.bg-canvas').toDataURL());
  ok('la animación cambia con el tiempo', frameA !== frameB);
  ok('con fondo, el terminal es transparente y se tiñe por CSS', (await activePane('p => p.term.options.theme.background')) === '#00000000' && Number(await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--term-alpha'))) < 0.9);
  const dataUrl = 'data:image/png;base64,' + png(64, 36, [30, 60, 120]).toString('base64');
  await ev((u) => window.vexor.setConfig({ bg: { mode: 'image', image: u, blur: 2 } }), dataUrl); await sleep(400);
  ok('fondo con imagen', (await ev(() => getComputedStyle(document.querySelector('.bg-img')).backgroundImage)).includes('data:image/png'));
  await ev(() => window.vexor.setConfig({ bg: { mode: 'none' }, opacity: 0.6 })); await sleep(300);
  ok('opacidad de ventana 60 %', (await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--chrome-alpha'))).trim() === '0.6' && (await activePane('p => p.term.options.theme.background')) === '#00000000');
  await ev(() => window.vexor.setConfig({ opacity: 1 })); await sleep(300);
  ok('opacidad 100 % restaura el fondo sólido', (await activePane('p => p.term.options.theme.background')) !== '#00000000');
  await sh('Control+Comma'); await sleep(300);
  await page.click('#settings .set-tab[data-tab="background"]'); await sleep(200);
  ok('ajustes de fondo (modo, imagen, oscurecer, velocidad, opacidad)', (await page.locator('#settings .tabpane:not([hidden]) select, #settings .tabpane:not([hidden]) input[type=range]').count()) >= 5);
  await sh('Escape'); await sleep(200);

  console.log('\n[26] Perfiles, layouts y SSH');
  await ev(() => window.vexor.setConfig({ profiles: [{ name: 'Tmp', cwd: '/tmp', command: 'echo perfil-ok' }] }));
  const tp = (await state()).tabs;
  await palette('perfil: tmp'); await sleep(1500);
  ok('perfil abre pestaña, directorio y comando', (await state()).tabs === tp + 1 && (await buf()).includes('perfil-ok') && (await activePane('p => p.cwd')) === '/tmp');
  const cmds = await ev(() => window.vexor.commands().map((c) => c.name));
  ok('hosts de ~/.ssh/config en la paleta (sin comodines)', cmds.includes('SSH: prod') && cmds.includes('SSH: web1') && !cmds.some((c) => c.includes('*')));
  await palette('ssh: prod'); await sleep(1200);
  ok('SSH abre pestaña con `ssh prod`', (await buf()).includes('ssh prod'));
  await palette('guardar layout'); await sleep(300);
  ok('pide el nombre del layout', await page.isVisible('#dialog .modal'));
  await page.keyboard.type('L1'); await sh('Enter'); await sleep(600);
  ok('el layout aparece en la paleta', (await ev(() => window.vexor.commands().map((c) => c.name))).includes('Layout: L1'));
  const tl = (await state()).tabs;
  await palette('layout: l1'); await sleep(1200);
  ok('cargar layout añade sus pestañas', (await state()).tabs > tl);
  await palette('eliminar layout'); await sleep(500);
  ok('eliminar layout', !(await ev(() => window.vexor.commands().map((c) => c.name))).includes('Layout: L1'));

  console.log('\n[27] Pegado seguro, arrastrar archivos y mover pestañas');
  await focusTerm();
  await type("bind 'set enable-bracketed-paste off'");
  await waitFor(async () => (await activePane('p => p.term.modes.bracketedPasteMode')) === false, 4000);
  await ev(() => { const ta = window.vexor.active().focus.term.textarea; const dt = new DataTransfer(); dt.setData('text', 'echo pega-1\necho pega-2'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(300);
  ok('pegar varias líneas pide confirmación', (await page.isVisible('#dialog .modal')) && (await txt('#dialog')).includes('2 líneas'));
  await sh('Escape'); await sleep(300);
  ok('cancelar no pega nada', !(await buf()).includes('pega-1\n'));
  await ev(() => { const ta = window.vexor.active().focus.term.textarea; const dt = new DataTransfer(); dt.setData('text', 'echo pega-1\necho pega-2'); ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await sleep(300); await sh('Enter'); await sleep(800);
  ok('confirmar pega el texto (y el Enter de confirmar no se cuela en la terminal)', (await buf()).split('\n').includes('pega-1') && (await buf()).trimEnd().split('\n').pop().endsWith('echo pega-2'));
  await sh('Enter'); await sleep(500);
  ok('la última línea se ejecuta al pulsar Enter', (await buf()).split('\n').includes('pega-2'));
  await ev(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'mi archivo.txt')); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); });
  await sleep(400);
  ok('arrastrar un archivo pega su ruta entrecomillada', (await buf()).includes("'mi archivo.txt'"));
  await sh('Control+u');
  await sh('Alt+9'); await sleep(300);
  const ia = await ev(() => window.vexor.tabs().indexOf(window.vexor.active()));
  await sh('Control+Shift+PageUp'); await sleep(300);
  ok('mover pestaña a la izquierda', (await ev(() => window.vexor.tabs().indexOf(window.vexor.active()))) === ia - 1 || ia === 0);

  console.log('\n[28] Historial: pager y exportación');
  await focusTerm(); await type('echo historial-visible');
  await palette('exportar historial'); await sleep(1000);
  const dir = path.join(os.tmpdir(), 'vexor');
  const html = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).map((f) => path.join(dir, f)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0];
  ok('exporta el historial a HTML', !!html && fs.readFileSync(html, 'utf8').includes('<') && fs.readFileSync(html, 'utf8').includes('historial-visible'));
  const tpg = (await state()).tabs;
  await palette('pager'); await sleep(1800);
  ok('abre el historial en less', (await state()).tabs === tpg + 1 && await waitFor(async () => (await activePane('p => p.fg')) === 'less', 5000));
  await sh('q'); await sleep(400);

  console.log('\n[29] Argumentos de línea de comandos (--working-directory, -e, --no-restore)');
  const page2 = await ctx.newPage();
  await page2.goto('http://127.0.0.1:4174/?renderer=dom'); await sleep(2500);
  const info2 = await page2.evaluate(() => { const p = window.vexor.active().focus; const b = p.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) + '\n'; return { tabs: window.vexor.tabs().length, text: s }; });
  ok('abre una sola pestaña y ejecuta el comando de -e', info2.tabs === 1 && info2.text.includes('desde-cli'));
  ok('usa el directorio de --working-directory', await waitFor(async () => (await page2.evaluate(() => window.vexor.active().focus.cwd)) === '/tmp', 4000));
  await page2.close(); await page.bringToFront(); await sleep(300);

  console.log('\n[30] Medidas de rendimiento (referencia, no es una comparación con Kitty/Alacritty)');
  await sh('Control+Shift+T'); await sleep(1200); await focusTerm();
  await waitFor(async () => (await buf()).includes('❯'), 5000);
  const lat = await ev(async () => {
    const p = window.vexor.active().focus, id = p.id, res = [];
    const lastLine = () => { const b = p.term.buffer.active; return (b.getLine(b.baseY + b.cursorY)?.translateToString(true) ?? '').trimEnd(); };
    const until = async (fn, max) => { const t = performance.now(); while (!fn() && performance.now() - t < max) await new Promise((r) => setTimeout(r, 0)); return performance.now() - t; };
    const base = lastLine().length;
    for (let i = 0; i < 25; i++) {
      await until(() => lastLine().length === base, 500);
      const t0 = performance.now();
      window.vexor.transport.write(id, 'x');
      await until(() => lastLine().length > base, 500);
      res.push(performance.now() - t0);
      window.vexor.transport.write(id, '\x7f');
    }
    const raw = res.map((x) => Math.round(x * 10) / 10); res.sort((a, b) => a - b); return { median: res[12], p95: res[23], base, raw, line: lastLine() };
  });
  console.log(`    arranque hasta el primer prompt: ${startupMs} ms · 300 000 líneas: ${bulkMs} ms · eco de una tecla (mediana / p95): ${lat.median.toFixed(1)} / ${lat.p95.toFixed(1)} ms`);
  ok('eco de teclado fluido (mediana < 30 ms)', lat.median < 30, String(lat.median));


  console.log('\n[32] Espacios de trabajo');
  await ev(() => window.vexor.setConfig({ restoreSession: true }));
  ok('arranca con el espacio “Principal”', (await ev(() => window.vexor.workspaces().map((w) => w.name))).join() === 'Principal' && (await txt('#ws-btn')).includes('Principal'));
  await focusTerm(); await type('echo en-principal');
  const nPrin = (await state()).tabs;
  await sh('Control+Alt+n'); await sleep(300);
  ok('Ctrl+Alt+N pide el nombre', await page.isVisible('#dialog .modal'));
  await page.keyboard.type('Backend'); await sh('Enter'); await sleep(1200);
  ok('crea y activa el espacio nuevo', (await ev(() => window.vexor.curWs().name)) === 'Backend' && (await txt('#ws-btn')).includes('Backend'));
  ok('el espacio nuevo tiene su propia pestaña (aislado)', (await page.$$('#tabs .tab')).length === 1 && (await state()).tabs === 1);
  await focusTerm(); await type('echo en-backend'); await sleep(500);
  await sh('Control+Alt+1'); await sleep(900);
  ok('Ctrl+Alt+1 vuelve a Principal con sus pestañas', (await txt('#ws-btn')).includes('Principal') && (await state()).tabs === nPrin);
  ok('los procesos del otro espacio siguen vivos', (await ev(() => [...window.vexor.panes.values()].some((p) => { const b = p.term.buffer.active; for (let i = 0; i < b.length; i++) if ((b.getLine(i)?.translateToString(true) || '') === 'en-backend') return true; return false; }))));
  await sh('Control+Alt+PageDown'); await sleep(700);
  ok('Ctrl+Alt+RePág/AvPág cambia de espacio', (await ev(() => window.vexor.curWs().name)) === 'Backend');
  await sh('Control+Alt+1'); await sleep(500);
  await page.click('#ws-btn'); await sleep(250);
  const wsMenu = await txt('.ctx');
  ok('menú de espacios (lista, nuevo, renombrar, color, eliminar)', ['Principal', 'Backend', 'Nuevo espacio', 'Renombrar', 'color', 'Eliminar'].every((x) => wsMenu.includes(x)));
  await sh('Escape'); await sleep(200);
  const tabsBefore = (await state()).tabs;
  await page.locator('#tabs .tab').first().click({ button: 'right' }); await sleep(250);
  const tabMenuText = await txt('.ctx');
  ok('menú de pestaña (renombrar, duplicar, mover, cerrar otras)', ['Renombrar', 'Duplicar', 'Mover a “Backend”', 'Cerrar otras', 'Cerrar pestaña'].every((x) => tabMenuText.includes(x)), tabMenuText);
  await page.click('.ctx-item:has-text("Mover a “Backend”")'); await sleep(900);
  ok('mover una pestaña a otro espacio', (await state()).tabs === tabsBefore - 1 && (await ev(() => window.vexor.workspaces().find((w) => w.name === 'Backend').tabs.length)) === 2);
  await palette('renombrar espacio'); await sleep(300);
  await page.keyboard.press('Control+a'); await page.keyboard.type('Principal 2'); await sh('Enter'); await sleep(400);
  ok('renombrar el espacio', (await txt('#ws-btn')).includes('Principal 2'));
  await sh('Control+Alt+n'); await sleep(300); await page.keyboard.type('Persistente'); await sh('Enter'); await sleep(1200);
  await ev(() => window.vexor.saveSession()); await sleep(800);
  await page.reload(); await sleep(2500);
  ok('los espacios de trabajo se restauran al recargar', (await ev(() => window.vexor.workspaces().map((w) => w.name))).join('|') === 'Principal 2|Backend|Persistente', (await ev(() => window.vexor.workspaces().map((w) => w.name))).join('|'));
  ok('se restaura el espacio activo', (await ev(() => window.vexor.curWs().name)) === 'Persistente');
  await palette('eliminar espacio de trabajo'); await sleep(900);
  ok('eliminar el espacio actual (pasa al vecino)', (await ev(() => window.vexor.workspaces().length)) === 2 && (await ev(() => window.vexor.curWs().name)) !== 'Persistente');
  await ev(() => window.vexor.switchWorkspace(window.vexor.workspaces().find((w) => w.name === 'Backend'))); await sleep(500);
  await palette('eliminar espacio de trabajo'); await sleep(900);
  ok('al borrar otro espacio queda solo uno', (await ev(() => window.vexor.workspaces().length)) === 1);
  await ev(() => window.vexor.setConfig({ restoreSession: false }));

  console.log('\n[33] Pestañas en barra lateral');
  await ev(() => window.vexor.setConfig({ ui: { tabs: 'left' } })); await sleep(400);
  ok('barra lateral visible con las pestañas y el espacio', (await page.isVisible('#vtabs')) && (await ev(() => document.querySelector('#tabs').parentElement.id)) === 'vt-tabs' && (await ev(() => document.querySelector('#ws-btn').parentElement.id)) === 'vt-ws');
  ok('las pestañas se apilan en vertical', await ev(() => { const t = [...document.querySelectorAll('#tabs .tab')]; return t.length < 2 || t[1].getBoundingClientRect().top > t[0].getBoundingClientRect().top + 10; }));
  const tv = (await state()).tabs;
  await page.click('#vt-new'); await sleep(900);
  ok('“+ Nueva pestaña” de la barra lateral funciona', (await state()).tabs === tv + 1);
  await page.dblclick('#vtabs .tab.active .name'); await page.keyboard.type('Lateral'); await sh('Enter'); await sleep(200);
  ok('renombrar con doble clic en la barra lateral', (await txt('#vtabs')).includes('Lateral'));
  await palette('pestañas: mostrar arriba'); await sleep(400);
  ok('vuelve a la barra superior', !(await page.isVisible('#vtabs')) && (await ev(() => document.querySelector('#tabs').parentElement.id)) === 'tabs-slot');

  console.log('\n[34] Tamaño de la interfaz');
  const fs0 = await ev(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), tb0 = await ev(() => document.querySelector('#tabbar').getBoundingClientRect().height);
  await ev(() => window.vexor.setUiScale(1.3)); await sleep(400);
  const fs1 = await ev(() => parseFloat(getComputedStyle(document.documentElement).fontSize)), tb1 = await ev(() => document.querySelector('#tabbar').getBoundingClientRect().height);
  ok('130 %: toda la interfaz escala (fuente base y barra superior)', Math.abs(fs1 / fs0 - 1.3) < 0.02 && Math.abs(tb1 / tb0 - 1.3) < 0.05, `${fs0}→${fs1}, ${tb0}→${tb1}`);
  ok('la terminal sigue ajustándose al nuevo tamaño', (await activePane('p => p.term.cols')) > 20);
  await sh('Control+Alt+0'); await sleep(400);
  ok('Ctrl+Alt+0 restablece el 100 %', Math.abs((await ev(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) - fs0) < 0.1);
  await sh('Control+Alt+='); await sleep(300);
  ok('Ctrl+Alt+= agranda', (await ev(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) > fs0);
  await sh('Control+Alt+0'); await sleep(300);
  await sh('Control+Comma'); await sleep(300);
  await ev(() => { const r = document.querySelector('#settings input[type=range]'); r.value = 1.5; r.dispatchEvent(new Event('input', { bubbles: true })); });
  ok('el deslizador de Ajustes previsualiza en vivo', (await ev(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) > fs0 * 1.4);
  await sh('Escape'); await sleep(300);
  ok('cancelar revierte la previsualización', Math.abs((await ev(() => parseFloat(getComputedStyle(document.documentElement).fontSize))) - fs0) < 0.1);

  console.log('\n[35] Modo zen y ventana');
  await focusTerm(); await sh('Control+Shift+Enter'); await sleep(300);
  ok('zen oculta barra superior y barra de estado', !(await page.isVisible('#tabbar')) && !(await page.isVisible('#status')));
  await sh('Control+Shift+Enter'); await sleep(300);
  ok('zen se desactiva con el mismo atajo', (await page.isVisible('#tabbar')) && (await page.isVisible('#status')));
  await palette('ventana: 1280'); await sleep(500);
  ok('el tamaño de ventana elegido se guarda', JSON.parse(fs.readFileSync(path.join(TMPD, 'cfg.json'), 'utf8')).window?.w === 1280);

  console.log('\n[36] Buscador de historial de comandos');
  await focusTerm(); await type('echo hist-live-xyz'); await sleep(900);
  await sh('Control+Shift+R'); await sleep(500);
  ok('se abre el buscador de historial', await page.isVisible('#history .box'));
  await page.keyboard.type('hist-live'); await sleep(500);
  ok('ve los comandos de la sesión abierta (history -a)', (await txt('#history-list')).includes('echo hist-live-xyz'));
  await page.fill('#history-input', 'docker comp'); await sleep(300);
  ok('y los guardados de antes (filtro difuso)', (await txt('#history-list')).includes('docker compose up'));
  await sh('Enter'); await sleep(500);
  ok('Enter inserta el comando en el prompt', (await buf()).trimEnd().split('\n').pop().includes('docker compose up'));
  await sh('Control+u');
  await sh('Control+Shift+R'); await sleep(400); await page.fill('#history-input', 'echo hist-live'); await sleep(200);
  await sh('Shift+Enter'); await sleep(900);
  ok('Mayús+Enter lo ejecuta', (await buf()).split('\n').filter((l) => l === 'hist-live-xyz').length >= 2);

  console.log('\n[37] Explorador de archivos');
  await type(`cd ${ROOT}`); await waitFor(async () => (await activePane('p => p.cwd')) === ROOT);
  await sh('Control+Shift+J'); await sleep(1200);
  const ft = await txt('#side');
  ok('lista el directorio de la terminal', ft.includes('package.json') && ft.includes('src-tauri') && ft.includes('README.md'));
  ok('carpetas antes que archivos', (await ev(() => { const r = [...document.querySelectorAll('#side .row .row-title')].map((e) => e.textContent); return r.indexOf('src') < r.indexOf('package.json'); })));
  await page.fill('#side input[aria-label="Filtrar archivos"]', 'pack'); await sleep(300);
  ok('el filtro reduce la lista', !(await txt('#side')).includes('README.md') && (await txt('#side')).includes('package.json'));
  await page.locator('#side .row', { hasText: 'package.json' }).first().click(); await sleep(400);
  ok('clic en un archivo inserta su ruta', (await buf()).trimEnd().split('\n').pop().includes('/package.json'));
  await sh('Control+u'); await page.fill('#side input[aria-label="Filtrar archivos"]', ''); await sleep(200);
  await page.locator('#side .row', { hasText: /^src$/ }).first().click(); await sleep(700);
  ok('clic en una carpeta navega (migas de pan)', (await txt('#side .crumbs')).trim().endsWith('src') && (await txt('#side')).includes('main.js'));
  ok('al navegar deja de seguir a la terminal', !(await ev(() => document.querySelector('#side .view:not([hidden]) .ai-foot input[type=checkbox]').checked)));
  await page.locator('#side .row', { hasText: 'main.js' }).first().hover();
  await page.locator('#side .row', { hasText: /^\.\.$/ }).first().click(); await sleep(500);
  await page.locator('#side .row', { hasText: /^src$/ }).first().hover();
  await page.locator('#side .row', { hasText: /^src$/ }).first().locator('button[title^="cd aquí"]').click(); await sleep(900);
  ok('“cd aquí” cambia el directorio de la terminal', await waitFor(async () => (await activePane('p => p.cwd')) === `${ROOT}/src`, 4000));
  await page.check('#side .ai-foot label:has-text("Ocultos") input'); await sleep(500);
  await page.locator('#side button[title="Carpeta personal"]').click(); await sleep(500);
  ok('mostrar archivos ocultos y carpeta personal', (await txt('#side .crumbs')).length > 0 && (await txt('#side')).includes('.bash_history'));

  console.log('\n[38] Tareas del proyecto');
  await focusTerm(); await type(`cd ${TMPD}/proj`); await waitFor(async () => (await activePane('p => p.cwd')) === `${TMPD}/proj`);
  await sh('Control+Shift+M'); await sleep(1500);
  const tt = await txt('#side');
  ok('detecta package.json y Makefile', tt.includes('hello') && tt.includes('npm run hello') && tt.includes('mk') && tt.includes('make mk'));
  const tn = (await state()).tabs;
  await page.locator('#side .row', { hasText: 'npm run hello' }).click(); await sleep(2500);
  ok('ejecutar una tarea abre una pestaña en el proyecto', (await state()).tabs === tn + 1 && (await activePane('p => p.cwd')) === `${TMPD}/proj`);
  ok('la tarea se ejecuta', await waitFor(async () => (await buf()).split('\n').includes('hello-task'), 8000));

  console.log('\n[39] Procesos y puertos');
  await focusTerm(); await type('sleep 987');
  await sh('Control+Shift+Y'); await sleep(1500);
  ok('Sistema abre en el resumen (CPU, memoria, red, discos)', /cpu/i.test(await txt('#side .cards')) && /memoria/i.test(await txt('#side .cards')) && (await page.$$('#side canvas.spark')).length === 1 && (await page.$$('#side .disk')).length >= 1);
  await page.click('#side .seg2 button[data-t="proc"]'); await sleep(600);
  await page.fill('#side input[aria-label="Filtrar"]', 'sleep'); await sleep(2000);
  ok('lista los procesos con PID, CPU y RAM', (await txt('#side')).includes('sleep') && /PID \d+/.test(await txt('#side')));
  await page.locator('#side .row.proc', { hasText: 'sleep' }).first().locator('button[title^="Terminar"]').click(); await sleep(400);
  ok('terminar pide confirmación', await page.isVisible('#dialog .modal'));
  await sh('Enter'); await sleep(1200);
  ok('el proceso termina de verdad', await waitFor(async () => !require('child_process').execSync('ps -eo args').toString().includes('sleep 987'), 5000));
  await sh('Control+Shift+t'); await sleep(900); await focusTerm(); await type('python3 -m http.server 8765 >/dev/null 2>&1 &'); await sleep(1200);
  await page.click('#side .seg2 button[data-t="ports"]'); await page.fill('#side input[aria-label="Filtrar"]', '8765'); await sleep(2200);
  ok('lista los puertos en escucha', (await txt('#side')).includes(':8765') && (await txt('#side')).includes('python3'));
  await page.locator('#side .row.proc', { hasText: '8765' }).first().locator('button[title="Terminar el proceso"]').click(); await sleep(400);
  await sh('Enter'); await sleep(1200);
  ok('terminar el proceso libera el puerto', await waitFor(async () => !require('child_process').execSync('ss -H -tln').toString().includes(':8765'), 5000));

  console.log('\n[40] Notas');
  await sh('Control+Shift+Q'); await sleep(500);
  await page.fill('#side textarea.notes', 'TODO: revisar el deploy\nnpm run build'); await sleep(1000);
  ok('las notas se guardan solas', /guardado/.test(await txt('#side .view:not([hidden]) .ai-foot')));
  await page.reload(); await waitFor(async () => (await buf()).includes('❯'), 10000);
  await sh('Control+Shift+Q'); await sleep(600);
  ok('las notas persisten al recargar', (await ev(() => document.querySelector('#side textarea.notes').value)).includes('revisar el deploy'));
  await sh('Control+Shift+Backquote'); await sleep(300);
  ok('el panel lateral se oculta con su atajo', !(await state()).side);

  console.log('\n[41] Escribir en español (ñ, tildes, ü, ¿¡)');
  await focusTerm(); await sh('Control+u');
  await type('echo año-canción-pingüino-¿qué?-¡ya!');
  ok('las letras con tilde, la ñ y la ü llegan al shell', await waitFor(async () => (await buf()).split('\n').includes('año-canción-pingüino-¿qué?-¡ya!'), 4000));
  await ev(() => { window.vexor.active().focus.term.paste('echo pegado-ñandú\r'); }); await sleep(500);
  ok('y también al pegar (sin ejecutarse: bracketed paste)', (await buf()).trimEnd().split('\n').pop().includes('echo pegado-ñandú'));
  await sh('Control+u');


  console.log('\n[42] Marcas de comando en su sitio');
  await sh('Control+Shift+T'); await sleep(1000); await focusTerm();
  await type('seq 1 6'); await type('false'); await sleep(600);
  const mk = await ev(() => { const p = window.vexor.active().focus, b = p.term.buffer.active; const scr = p.el.querySelector('.xterm-screen').getBoundingClientRect(); const ch = scr.height / p.term.rows;
    const m = p.prompts.find((x) => (b.getLine(x.line)?.translateToString(true) || '').trimEnd().endsWith('false')); const el = [...p.el.querySelectorAll('.cmd-mark.is-fail')].pop();
    return { expected: scr.top + (m.line - b.viewportY) * ch, got: el.getBoundingClientRect().top }; });
  ok('la marca roja queda junto a su comando (no apilada arriba)', Math.abs(mk.expected - mk.got) < 2, JSON.stringify(mk));

  console.log('\n[43] Copiar la salida del último comando');
  await type(R`printf 'sal-A\nsal-B\n'`); await sleep(600);
  await sh('Control+Shift+X'); await sleep(300);
  ok('Ctrl+Shift+X copia solo la salida', (await clip()) === 'sal-A\nsal-B', JSON.stringify(await clip()));

  console.log('\n[44] Snippets con variables');
  await ev(() => window.vexor.setConfig({ snippets: [{ name: 'Saludo', cmd: 'echo hola {{nombre}} y {{nombre}}' }] }));
  await palette('snippet: saludo'); await sleep(400);
  ok('pide el valor de la variable', (await page.isVisible('#dialog .modal')) && (await txt('#dialog')).includes('nombre'));
  await page.keyboard.type('Mundo'); await sh('Enter'); await sleep(500);
  ok('sustituye todas las apariciones', (await buf()).trimEnd().split('\n').pop().includes('echo hola Mundo y Mundo'));
  await sh('Control+u');

  console.log('\n[45] Carpetas favoritas');
  await type(`cd ${ROOT}/src`); await waitFor(async () => (await activePane('p => p.cwd')) === `${ROOT}/src`);
  await sh('Control+Shift+J'); await sleep(1200);
  await page.check('#side .view:not([hidden]) .ai-foot label:has-text("Seguir") input'); await sleep(800);
  await page.click('#side button[title^="Añadir o quitar"]'); await sleep(500);
  ok('la estrella añade la carpeta a favoritos', (await txt('#side .favs')).includes('src') && JSON.parse(fs.readFileSync(path.join(TMPD, 'cfg.json'), 'utf8')).bookmarks?.[0] === `${ROOT}/src`);
  await focusTerm(); await type('cd /tmp'); await waitFor(async () => (await activePane('p => p.cwd')) === '/tmp');
  await palette('favorito'); await sleep(300);
  ok('la paleta salta al favorito', await waitFor(async () => (await activePane('p => p.cwd')) === `${ROOT}/src`, 4000));

  console.log('\n[46] Cliente HTTP');
  await sh('Control+Alt+a'); await sleep(500);
  await page.fill('#side input[aria-label="URL"]', 'http://127.0.0.1:4173/__notifications'); await sh('Enter');
  ok('GET devuelve estado 200', await waitFor(async () => (await txt('#side .pill.status')).includes('200'), 5000));
  ok('muestra el cuerpo con formato JSON', (await txt('#side .api-body')).trim().startsWith('['));
  await page.click('#side .api-out .seg2 button:nth-child(2)'); await sleep(200);
  ok('muestra las cabeceras', /content-type: application\/json/i.test(await txt('#side .api-body')));
  await page.click('#side .api-out .chip:has-text("A la terminal")'); await sleep(400);
  ok('escribe el curl equivalente en la terminal', (await buf()).trimEnd().split('\n').pop().includes("curl -X GET 'http://127.0.0.1:4173/__notifications'"));
  await sh('Control+u');
  await page.fill('#side input[aria-label="URL"]', 'http://127.0.0.1:9/nada'); await sh('Enter');
  ok('un fallo de conexión se explica', await waitFor(async () => (await page.isVisible('#side .api-err')) && /no se pudo/i.test(await txt('#side .api-err')), 8000));
  ok('la petición correcta queda en recientes', (JSON.parse(fs.readFileSync(path.join(TMPD, 'cfg.json'), 'utf8')).httpHistory || []).some((r) => r.url.endsWith('/__notifications')));

  console.log('\n[47] Procesos que terminan en otro espacio de trabajo');
  await sh('Control+Shift+Backquote'); await sleep(300);
  await ev(() => window.vexor.setConfig({ restoreSession: true }));
  const tabsA = (await state()).tabs, nameA = await ev(() => window.vexor.curWs().name);
  await sh('Control+Alt+n'); await sleep(300); await page.keyboard.type('Efimero'); await sh('Enter'); await sleep(1300);
  await focusTerm(); await type("(sleep 1; printf '\\a') & sleep 3; exit"); await sleep(200);
  await sh('Control+Alt+1'); await sleep(1700);
  ok('aviso en el selector cuando suena la campana en otro espacio', (await page.$$('#ws-btn .dot')).length === 1);
  await sleep(2600);
  ok('al terminar, se cierra SU pestaña (no una del espacio activo)', (await state()).tabs === tabsA && (await ev(() => window.vexor.curWs().name)) === nameA, JSON.stringify(await state()));
  ok('el espacio vacío desaparece', (await ev(() => window.vexor.workspaces().map((w) => w.name))).includes('Efimero') === false);
  ok('el aviso se limpia', (await page.$$('#ws-btn .dot')).length === 0);
  await ev(() => window.vexor.setConfig({ restoreSession: false }));

  console.log('\n[48] Estilo futurista, temas y animación de inicio');
  ok('estilo futurista activo por defecto', await ev(() => document.body.classList.contains('hud')));
  ok('esquinas en ángulo en las pestañas', (await ev(() => getComputedStyle(document.querySelector('#tabs .tab')).clipPath)).startsWith('polygon'));
  await ev(() => window.vexor.setConfig({ ui: { style: 'clean' } })); await sleep(200);
  ok('el estilo limpio se puede recuperar', !(await ev(() => document.body.classList.contains('hud'))) && (await ev(() => getComputedStyle(document.querySelector('#tabs .tab')).clipPath)) === 'none');
  await ev(() => window.vexor.setConfig({ ui: { style: 'hud', glow: true } })); await sleep(200);
  ok('resplandor opcional', await ev(() => document.body.classList.contains('glow') && getComputedStyle(document.querySelector('#logo .mark')).boxShadow !== 'none'));
  await ev(() => window.vexor.setConfig({ ui: { glow: false } }));
  for (const [name, accent] of [['Synthwave', '#ff4fd8'], ['Ámbar', '#ffb000'], ['Vexor Cyber', '#00d8ff']]) {
    await ev((n) => window.vexor.setConfig({ theme: n }), name); await sleep(150);
    ok(`tema ${name}`, (await ev(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === accent);
  }
  await page.reload();
  ok('animación de inicio visible al arrancar', !!(await page.waitForSelector('#boot', { timeout: 2000 }).catch(() => null)));
  await sleep(1600);
  ok('y desaparece sola', (await page.$$('#boot')).length === 0);
  await waitFor(async () => (await buf()).includes('❯'), 8000);


  console.log('\n[49] Rendimiento de las ventanas');
  await focusTerm();
  const fx = await ev(() => { window.vexor.settings.open(); const cs = getComputedStyle(document.querySelector('#settings')); const r = { blur: cs.backdropFilter || 'none', anim: cs.animationName }; window.vexor.settings.close(); return r; });
  ok('las ventanas no usan desenfoque de fondo (era lo que las hacía lentas)', fx.blur === 'none' && fx.anim === 'none', JSON.stringify(fx));
  const openMs = await ev(async () => {
    const frames = (n) => new Promise((res) => { let i = 0; const f = () => (++i >= n ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const t = [];
    for (let i = 0; i < 7; i++) { const t0 = performance.now(); window.vexor.settings.open(); await frames(2); t.push(performance.now() - t0); window.vexor.settings.close(); await frames(2); }
    return t.sort((a, b) => a - b)[3];
  });
  console.log(`    Ajustes: abierto y pintado en ${openMs.toFixed(0)} ms (mediana)`);
  ok('Ajustes se abre y se pinta en menos de 100 ms', openMs < 100, String(openMs));
  ok('sin fondo ni opacidad, la terminal no usa transparencia (más rápida)', (await activePane('p => p.term.options.allowTransparency')) === false);
  await ev(() => window.vexor.setConfig({ bg: { mode: 'stars' } })); await sleep(300);
  ok('con fondo animado la activa', (await activePane('p => p.term.options.allowTransparency')) === true);
  await ev(() => window.vexor.setConfig({ bg: { mode: 'none' } })); await sleep(300);

  console.log('\n[31] Errores');
  ok('sin errores de consola/página', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  console.log(`\nRESULTADO: ${pass} correctas, ${fail} fallidas`);
  if (fail) console.log('FALLOS:', fails.join(' | '));
  await b.close();
  process.exit(fail ? 1 : 0);
})();
