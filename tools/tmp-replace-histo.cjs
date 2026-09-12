const fs = require('fs');
let lines = fs.readFileSync('src/app.js', 'utf8').split('\n');
const start = lines.findIndex((l) => l.includes('function drawHistogram'));
const end = lines.findIndex((l, i) => i > start && l.includes('/* ---------------- export'));
if (start < 0 || end < 0) { console.log('BOUNDS NOT FOUND', start, end); process.exit(1); }
const replacement = `  function drawHistogram() {
    const cv = document.getElementById('histo');
    if (!cv) return;
    const css = getComputedStyle(document.body);
    const cAccent = css.getPropertyValue('--accent').trim() || '#0af';
    const cMuted = css.getPropertyValue('--muted').trim() || '#888';
    const cGrid = css.getPropertyValue('--border').trim() || '#333';
    const cWarn = css.getPropertyValue('--warn').trim() || '#fa0';
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(140, cv.clientWidth || 600);
    const H = Math.max(90, cv.clientHeight || 120);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const tsRecs = store.kept.filter((r) => r.ts);
    if (tsRecs.length < 2) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = cMuted;
      ctx.fillText('need at least 2 timestamped lines', 8, 16);
      cv.onmousemove = null;
      cv.onmouseleave = null;
      return;
    }

    const toMs = (ts) => {
      const [d, t] = ts.split(' ');
      const [hh, mm, ss] = t.split(':');
      return Number(d.slice(3)) * 86400 + Number(hh) * 3600 + Number(mm) * 60 + Number(ss.split('.')[0]) + Number(ss.split('.')[1] || 0) / 1000;
    };
    const N = 100;
    const lo = toMs(tsRecs[0].ts), hi = toMs(tsRecs[tsRecs.length - 1].ts);
    const span = Math.max(1e-6, hi - lo);
    const counts = new Array(N).fill(0);
    const firstTs = new Array(N);
    const lastTs = new Array(N);
    for (const r of tsRecs) {
      const i = Math.min(N - 1, Math.floor((toMs(r.ts) - lo) / span * N));
      if (firstTs[i] == null) firstTs[i] = r.ts;
      lastTs[i] = r.ts;
      counts[i]++;
    }
    const max = Math.max(...counts, 1);
    const k = Math.pow(10, Math.floor(Math.log10(max)));
    let niceMax = max;
    for (const m of [1, 2, 5, 10]) { const c = m * k; if (c >= max) { niceMax = c; break; } }

    const x0 = 46, x1 = W - 10, y0 = 10, y1 = H - 18;
    const plotW = x1 - x0, plotH = y1 - y0;
    const yFor = (v) => y1 - (v / niceMax) * plotH;
    const xFor = (i) => x0 + (i + 0.5) * (plotW / N);
    const fmtCount = (v) => (v >= 10000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)));
    const fmtTick = (ms) => {
      const total = Math.floor(ms);
      const days = Math.floor(total / 86400);
      const rem = total - days * 86400;
      const hh = Math.floor(rem / 3600), mm = Math.floor((rem % 3600) / 60);
      return (tsRecs[0].ts.slice(0, 2)) + '-' + String(days).padStart(2, '0') + ' ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    };

    let hover = -1;
    function draw() {
      ctx.clearRect(0, 0, W, H);
      ctx.font = '10px sans-serif';
      ctx.textBaseline = 'middle';
      // y gridlines + tick labels (0 / half / max)
      for (let i = 0; i <= 2; i++) {
        const v = niceMax * i / 2;
        const y = yFor(v);
        ctx.strokeStyle = cGrid;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.fillStyle = cMuted; ctx.textAlign = 'right';
        ctx.fillText(fmtCount(v), x0 - 4, y);
      }
      // bars (hovered bar highlighted)
      const bw = plotW / N;
      for (let i = 0; i < N; i++) {
        if (!counts[i]) continue;
        const bh = (counts[i] / niceMax) * plotH;
        ctx.fillStyle = i === hover ? cWarn : cAccent;
        ctx.fillRect(x0 + i * bw + 0.5, yFor(counts[i]), Math.max(1, bw - 1), bh);
      }
      // x axis: baseline + time tick labels at ~5 positions
      ctx.strokeStyle = cGrid;
      ctx.beginPath(); ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.fillStyle = cMuted; ctx.textAlign = 'center';
      const tickIdx = [0, Math.floor(N * 0.25), Math.floor(N * 0.5), Math.floor(N * 0.75), N - 1];
      for (const ti of tickIdx) {
        const ts = firstTs[ti] != null ? firstTs[ti] : (lastTs[ti] != null ? lastTs[ti] : null);
        if (ts == null) continue;
        ctx.fillText(ts.slice(0, 11), xFor(ti), y1 + 8);
      }
      // hover tooltip
      if (hover >= 0) {
        const from = firstTs[hover] != null ? firstTs[hover].slice(0, 11) : '';
        const to = lastTs[hover] != null ? lastTs[hover].slice(0, 11) : from;
        const text1 = counts[hover] + ' line(s)';
        const text2 = 'from ' + from + (to !== from ? ' to ' + to : '');
        const bw2 = Math.max(ctx.measureText(text1).width, ctx.measureText(text2).width) + 12;
        const bx = Math.min(Math.max(x0 + hover * bw - bw2 / 2, x0), x1 - bw2);
        const by = Math.max(2, yFor(counts[hover]) - 30);
        ctx.fillStyle = css.getPropertyValue('--surface').trim() || '#222';
        ctx.strokeStyle = cGrid;
        ctx.beginPath(); ctx.rect(bx, by, bw2, 26); ctx.fill(); ctx.stroke();
        ctx.fillStyle = css.getPropertyValue('--fg').trim() || '#eee';
        ctx.textAlign = 'left';
        ctx.fillText(text1, bx + 6, by + 9);
        ctx.fillStyle = cMuted;
        ctx.fillText(text2, bx + 6, by + 20);
      }
    }

    cv.onmousemove = (e) => {
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left;
      if (x < x0 || x > x1) { if (hover !== -1) { hover = -1; draw(); } return; }
      const idx = Math.max(0, Math.min(N - 1, Math.floor((x - x0) / (x1 - x0) * N)));
      if (idx !== hover) { hover = idx; draw(); }
    };
    cv.onmouseleave = () => { if (hover !== -1) { hover = -1; draw(); } };

    draw();
  }

`;
lines.splice(start, end - start, replacement);
fs.writeFileSync('src/app.js', lines.join('\n'));
console.log('drawHistogram replaced');
