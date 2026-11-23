// Fondos: imagen o animaciones (lluvia digital, estrellas, red de partículas, gradiente suave).
import { h } from './ui.js';

const rgb = (hex) => { const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#000000';
const rand = (a, b) => a + Math.random() * (b - a);

const makers = {
  matrix() {
    const size = 16, glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ｦﾝ';
    let cols = [];
    return {
      resize(w) { cols = Array.from({ length: Math.ceil(w / size) }, () => rand(-60, 0)); },
      draw(ctx, w, hh, dt, c, speed) {
        ctx.fillStyle = `rgba(${c.bg},0.14)`; ctx.fillRect(0, 0, w, hh);
        ctx.font = `${size}px monospace`;
        cols.forEach((y, i) => {
          const ch = glyphs[(Math.random() * glyphs.length) | 0];
          ctx.fillStyle = `rgba(${c.a2},0.55)`;
          ctx.fillText(ch, i * size, y * size);
          cols[i] = y * size > hh && Math.random() > 0.975 ? 0 : y + dt * 14 * speed;
        });
      },
    };
  },
  stars() {
    let stars = [];
    return {
      resize(w, hh) { stars = Array.from({ length: Math.round((w * hh) / 5000) }, () => ({ x: rand(0, w), y: rand(0, hh), z: rand(0.2, 1) })); },
      draw(ctx, w, hh, dt, c, speed) {
        ctx.fillStyle = `rgb(${c.bg})`; ctx.fillRect(0, 0, w, hh);
        for (const s of stars) {
          s.x -= dt * 22 * s.z * speed; if (s.x < 0) { s.x = w; s.y = rand(0, hh); }
          ctx.fillStyle = `rgba(${c.fg},${0.15 + s.z * 0.55})`;
          ctx.fillRect(s.x, s.y, 1 + s.z * 1.6, 1 + s.z * 1.6);
        }
      },
    };
  },
  network() {
    let nodes = [];
    return {
      resize(w, hh) { nodes = Array.from({ length: Math.max(24, Math.min(90, Math.round((w * hh) / 20000))) }, () => ({ x: rand(0, w), y: rand(0, hh), vx: rand(-14, 14), vy: rand(-14, 14) })); },
      draw(ctx, w, hh, dt, c, speed) {
        ctx.fillStyle = `rgb(${c.bg})`; ctx.fillRect(0, 0, w, hh);
        for (const n of nodes) {
          n.x += n.vx * dt * speed; n.y += n.vy * dt * speed;
          if (n.x < 0 || n.x > w) n.vx *= -1; if (n.y < 0 || n.y > hh) n.vy *= -1;
        }
        ctx.lineWidth = 1;
        for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
          const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y);
          if (d < 150) { ctx.strokeStyle = `rgba(${c.a},${(1 - d / 150) * 0.32})`; ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y); ctx.stroke(); }
        }
        ctx.fillStyle = `rgba(${c.a},0.5)`;
        for (const n of nodes) { ctx.beginPath(); ctx.arc(n.x, n.y, 1.8, 0, 7); ctx.fill(); }
      },
    };
  },
  gradient() {
    let t = 0;
    return {
      resize() {},
      draw(ctx, w, hh, dt, c, speed) {
        t += dt * 0.12 * speed;
        ctx.fillStyle = `rgb(${c.bg})`; ctx.fillRect(0, 0, w, hh);
        const blobs = [[c.a, 0.2, 0.3, 0.9], [c.a2, 0.7, 0.6, 0.7], [c.a, 0.5, 0.9, 1.1]];
        blobs.forEach(([col, bx, by, ph], i) => {
          const x = (bx + Math.sin(t * ph + i) * 0.25) * w, y = (by + Math.cos(t * ph * 0.8 + i * 2) * 0.25) * hh, r = Math.max(w, hh) * 0.55;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(${col},0.16)`); g.addColorStop(1, `rgba(${col},0)`);
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, hh);
        });
      },
    };
  },
};

export const BG_MODES = [['none', 'Ninguno'], ['image', 'Imagen'], ['matrix', 'Lluvia digital'], ['stars', 'Estrellas'], ['network', 'Red de partículas'], ['gradient', 'Gradiente suave']];

/** Reduce una imagen elegida a un data URL JPEG ligero (máx. 1920×1080) para guardarla en la configuración. */
export async function imageToDataUrl(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1920 / bmp.width, 1080 / bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

export function initBackground(getCfg) {
  const stage = document.querySelector('#stage');
  const img = h('div', { class: 'bg-img' });
  const canvas = h('canvas', { class: 'bg-canvas' });
  const layer = h('div', { id: 'bg', 'aria-hidden': 'true' }, img, canvas);
  stage.prepend(layer);
  const ctx = canvas.getContext('2d');
  let raf = 0, anim = null, last = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function size() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(stage.clientWidth * dpr)); canvas.height = Math.max(1, Math.round(stage.clientHeight * dpr));
    anim?.resize(canvas.width, canvas.height);
  }
  const colors = () => ({ bg: rgb(css('--bg')).join(','), fg: rgb(css('--fg')).join(','), a: rgb(css('--accent')).join(','), a2: rgb(css('--accent2')).join(',') });

  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || t - last < 1000 / 30) return;
    const dt = Math.min(0.1, (t - last) / 1000); last = t;
    anim.draw(ctx, canvas.width, canvas.height, dt, colors(), getCfg().bg.speed || 1);
  }
  function stop() { cancelAnimationFrame(raf); raf = 0; anim = null; }

  function apply() {
    const bg = getCfg().bg;
    stop();
    img.style.backgroundImage = bg.mode === 'image' && bg.image ? `url("${bg.image}")` : 'none';
    img.style.filter = bg.blur ? `blur(${bg.blur}px)` : 'none';
    img.style.display = bg.mode === 'image' ? 'block' : 'none';
    const animated = makers[bg.mode];
    canvas.style.display = animated ? 'block' : 'none';
    if (animated) {
      anim = animated(); size();
      if (reduced()) { anim.draw(ctx, canvas.width, canvas.height, 0.016, colors(), 0); } else raf = requestAnimationFrame(frame);
    }
  }
  new ResizeObserver(() => { if (anim) size(); }).observe(stage);
  return { apply };
}
