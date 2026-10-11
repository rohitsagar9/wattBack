/* sc-render.js — canvas draw: grid, buildings, shadows, heat, panels, HUD */
import { DEG } from './sc-sun.js';
import { castShadow, obbCorners, cardinal } from './sc-geo.js';
import { terraceRect, roofY, worldToScreen } from './sc-world.js';

const COL = {
  ground: '#E5E1D8',
  grid: 'rgba(14,19,31,0.09)',
  gridMaj: 'rgba(14,19,31,0.20)',
  build: '#0E131F',
  buildTop: '#0E131F',
  parapet: '#0E131F',
  roof: '#EFEBE1',
  roofEdge: '#0E131F',
  shadow: 'rgba(14,19,31,0.30)',
  tank: '#4CC2FF',
  tankEdge: '#0E131F',
  tree: '#00FF88',
  treeEdge: '#0E131F',
  mumty: '#FF9800',
  mumtyEdge: '#0E131F',
  wall: '#4A5262',
  pole: '#4A5262',
  neighbor: 'rgba(14,19,31,0.82)',
  neighborEdge: '#0E131F',
  panel: '#4CC2FF',
  panelEdge: '#0E131F',
  panelShade: '#FF3B30',
  panelShadeEdge: '#0E131F',
  sel: '#0E131F',
  selHi: '#FF9800',
  heatG: 'rgba(0,255,136,0.35)',
  heatA: 'rgba(255,152,0,0.35)',
  heatR: 'rgba(255,59,48,0.30)',
  txt: '#4A5262',
  txtBright: '#0E131F',
  onDark: '#E8EDF7',
  measure: '#8A2BE2',
};

export function draw(ctx, canvas, project, ui) {
  const dpr = window.devicePixelRatio || 1;
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  if (canvas.width !== vw * dpr || canvas.height !== vh * dpr) {
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  ctx.fillStyle = COL.ground;
  ctx.fillRect(0, 0, vw, vh);

  const p = project;
  const W2S = (x, y) => worldToScreen(p, x, y);
  const s = p.ui.scale;
  const sun = ui.sun || { az: 180, el: 60 };
  const ry = roofY(p);

  // ── ground grid ──
  drawGrid(ctx, p, vw, vh);

  // ── neighbors (below / around) ──
  for (const o of p.objects) {
    if (o.kind === 'neighbor') drawNeighbor(ctx, p, o, W2S);
  }

  // ── building ──
  drawBuilding(ctx, p, W2S);

  // ── heat zones (if enabled) ──
  if (ui.heat && ui.heat.length) drawHeat(ctx, p, ui.heat, W2S);

  // ── shadows on roof ──
  if (ui.shadowsOn !== false) {
    for (const o of p.objects) {
      if (o.kind === 'neighbor') continue; // neighbors cast from outside — still cast
      const poly = castShadow(o, ry, sun.az, sun.el);
      if (poly) fillPoly(ctx, poly, W2S, COL.shadow);
    }
    // neighbors too
    for (const o of p.objects) {
      if (o.kind !== 'neighbor') continue;
      const poly = castShadow(o, ry, sun.az, sun.el);
      if (poly) fillPoly(ctx, poly, W2S, COL.shadow);
    }
  }

  // ── obstacles on roof ──
  for (const o of p.objects) {
    if (o.kind === 'neighbor') continue;
    drawObstacle(ctx, p, o, W2S);
  }

  // ── panels ──
  for (const pan of p.panels) drawPanel(ctx, p, pan, W2S, ui);

  // ── selection ──
  if (ui.selected) {
    const obj = findObj(p, ui.selected);
    if (obj) drawSelection(ctx, obj, W2S, s);
  }

  // ── ghost placement ──
  if (ui.ghost) drawGhost(ctx, p, ui, W2S);

  // ── measure ──
  if (ui.measurePts && ui.measurePts.length) drawMeasure(ctx, p, ui.measurePts, W2S);

  // ── compass / sun needle ──
  drawCompass(ctx, vw, vh, sun);
}

function findObj(p, id) {
  const o = p.objects.find(o => o.id === id) || p.panels.find(o => o.id === id);
  if (o) return o;
  if (id === 'building') {
    const b = p.building;
    return { x: b.x + b.w / 2, y: b.y + b.d / 2, w: b.w, d: b.d, rot: 0 };
  }
  return null;
}

function drawGrid(ctx, p, vw, vh) {
  const s = p.ui.scale;
  // world bounds visible
  const x0 = (0 - p.ui.panX) / s, x1 = (vw - p.ui.panX) / s;
  const y0 = -(0 - p.ui.panY) / s, y1 = -(vh - p.ui.panY) / s;
  const step = s > 10 ? 1 : s > 5 ? 5 : 10; // world units per line
  const stepPx = step * s;
  if (stepPx < 4) return;
  ctx.save();
  for (let gx = Math.floor(x0 / step) * step; gx <= x1; gx += step) {
    const sx = gx * s + p.ui.panX;
    const major = Math.abs(gx % (step * 5)) < 0.01;
    ctx.strokeStyle = major ? COL.gridMaj : COL.grid;
    ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, vh); ctx.stroke();
  }
  for (let gy = Math.floor(y0 / step) * step; gy <= y1; gy += step) {
    const sy = -gy * s + p.ui.panY;
    const major = Math.abs(gy % (step * 5)) < 0.01;
    ctx.strokeStyle = major ? COL.gridMaj : COL.grid;
    ctx.beginPath(); ctx.moveTo(0, sy); ctx.lineTo(vw, sy); ctx.stroke();
  }
  ctx.restore();
}

function drawBuilding(ctx, p, W2S) {
  const b = p.building;
  const tr = terraceRect(p);
  // outer shell
  const c0 = W2S(b.x, b.y + b.d); // top-left in screen (NW corner world)
  const w = b.w * p.ui.scale, h = b.d * p.ui.scale;
  ctx.fillStyle = COL.build;
  ctx.fillRect(c0.x, c0.y, w, h);
  // roof fill
  const t0 = W2S(tr.x, tr.y + tr.d);
  const tw = tr.w * p.ui.scale, th = tr.d * p.ui.scale;
  ctx.fillStyle = COL.roof;
  ctx.fillRect(t0.x, t0.y, tw, th);
  // parapet outline
  ctx.strokeStyle = COL.parapet;
  ctx.lineWidth = Math.max(2, 0.4 * p.ui.scale);
  ctx.strokeRect(t0.x, t0.y, tw, th);
  // outer building edge
  ctx.strokeStyle = COL.roofEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(c0.x, c0.y, w, h);
  // floor badge
  ctx.fillStyle = COL.onDark;
  ctx.font = `700 ${Math.min(14, 10 + p.ui.scale * 0.3)}px "Space Mono", monospace`;
  ctx.textAlign = 'left';
  ctx.fillText(`${b.floors}F · ${b.w}×${b.d}`, c0.x + 6, c0.y + 16);
}

function drawNeighbor(ctx, p, o, W2S) {
  const h = (o.floors || 1) * (o.floorH || 10);
  // depth cue: taller = darker
  const shade = Math.min(0.7, h / 60);
  const c = obbCorners(o);
  const pts = c.map(q => W2S(q.x, q.y));
  ctx.beginPath();
  pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.closePath();
  ctx.fillStyle = `rgba(14,19,31,${0.55 + shade * 0.4})`;
  ctx.fill();
  ctx.strokeStyle = COL.neighborEdge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // floor count
  const cx = W2S(o.x, o.y);
  ctx.fillStyle = COL.onDark;
  ctx.font = '700 11px "Space Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${o.floors || 1}F`, cx.x, cx.y + 4);
}

function drawObstacle(ctx, p, o, W2S) {
  const s = p.ui.scale;
  const c = obbCorners(o);
  const pts = c.map(q => W2S(q.x, q.y));
  ctx.beginPath();
  pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.closePath();
  let fill = COL.wall, edge = '#78716C';
  if (o.kind === 'tank') { fill = COL.tank; edge = COL.tankEdge; }
  else if (o.kind === 'tree') { fill = COL.tree; edge = COL.treeEdge; }
  else if (o.kind === 'mumty') { fill = COL.mumty; edge = COL.mumtyEdge; }
  else if (o.kind === 'pole') { fill = COL.pole; edge = '#E2E8F0'; }
  ctx.fillStyle = fill;
  ctx.fill();
  // block top highlight
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // height badge for tank/tree/mumty
  if (o.kind !== 'wall' && o.kind !== 'pole' && s > 5) {
    const ctr = W2S(o.x, o.y);
    ctx.fillStyle = 'rgba(14,19,31,0.85)';
    ctx.font = '700 9px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText((o.h || 0).toFixed(0) + 'ft', ctr.x, ctr.y + 3);
  }
  if (o.kind === 'tank') {
    // tank ring
    const ctr = W2S(o.x, o.y);
    const r = Math.min(o.w, o.d) * s * 0.35;
    ctx.beginPath();
    ctx.arc(ctr.x, ctr.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(96,165,250,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawPanel(ctx, p, pan, W2S, ui) {
  const c = obbCorners(pan);
  const pts = c.map(q => W2S(q.x, q.y));
  ctx.beginPath();
  pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.closePath();
  const shaded = ui.panelShade && ui.panelShade[pan.id];
  ctx.fillStyle = shaded ? COL.panelShade : COL.panel;
  ctx.fill();
  ctx.strokeStyle = shaded ? COL.panelShadeEdge : COL.panelEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  // cell lines (Minecraft PV look)
  if (p.ui.scale > 6) {
    ctx.strokeStyle = 'rgba(14,19,31,0.35)';
    ctx.lineWidth = 0.5;
    // approximate 2×3 cell grid
    const ctr = W2S(pan.x, pan.y);
    ctx.beginPath();
    ctx.moveTo(ctr.x - pan.w * p.ui.scale / 2, ctr.y);
    ctx.lineTo(ctr.x + pan.w * p.ui.scale / 2, ctr.y);
    ctx.moveTo(ctr.x, ctr.y - pan.d * p.ui.scale / 2);
    ctx.lineTo(ctr.x, ctr.y + pan.d * p.ui.scale / 2);
    ctx.stroke();
  }
}

function drawHeat(ctx, p, cells, W2S) {
  const s = p.ui.scale;
  for (const c of cells) {
    const pt = W2S(c.x, c.y);
    ctx.fillStyle = c.score >= 0.8 ? COL.heatG : c.score >= 0.4 ? COL.heatA : COL.heatR;
    ctx.fillRect(pt.x - s / 2, pt.y - s / 2, s + 0.5, s + 0.5);
  }
}

function drawSelection(ctx, obj, W2S, s) {
  const c = obbCorners(obj);
  const pts = c.map(q => W2S(q.x, q.y));
  ctx.beginPath();
  pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.closePath();
  ctx.strokeStyle = COL.sel;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  // handles
  for (const q of pts) {
    ctx.fillStyle = COL.selHi;
    ctx.fillRect(q.x - 4, q.y - 4, 8, 8);
    ctx.strokeStyle = COL.sel;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(q.x - 4, q.y - 4, 8, 8);
  }
}

function drawGhost(ctx, p, ui, W2S) {
  const g = ui.ghost;
  if (!g) return;
  const c = obbCorners(g);
  const pts = c.map(q => W2S(q.x, q.y));
  ctx.beginPath();
  pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.closePath();
  ctx.fillStyle = ui.ghostValid === false ? 'rgba(255,59,48,0.30)' : 'rgba(0,255,136,0.30)';
  ctx.fill();
  ctx.strokeStyle = ui.ghostValid === false ? COL.panelShade : COL.build;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawMeasure(ctx, p, pts, W2S) {
  const s = pts.map(q => W2S(q.x, q.y));
  ctx.strokeStyle = COL.measure;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  s.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y));
  ctx.stroke();
  ctx.setLineDash([]);
  for (const q of s) {
    ctx.fillStyle = COL.measure;
    ctx.beginPath(); ctx.arc(q.x, q.y, 3, 0, Math.PI * 2); ctx.fill();
  }
  if (s.length === 2) {
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const u = p.units === 'm' ? 'm' : 'ft';
    const mx = (s[0].x + s[1].x) / 2, my = (s[0].y + s[1].y) / 2;
    ctx.fillStyle = 'rgba(14,19,31,0.9)';
    ctx.fillRect(mx - 30, my - 19, 60, 17);
    ctx.strokeStyle = COL.selHi;
    ctx.lineWidth = 1;
    ctx.strokeRect(mx - 30, my - 19, 60, 17);
    ctx.fillStyle = '#00FF88';
    ctx.font = '700 11px "Space Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(dist.toFixed(1) + ' ' + u, mx, my - 6);
  }
}

function drawCompass(ctx, vw, vh, sun) {
  const x = vw - 42, y = 42;
  ctx.save();
  ctx.translate(x, y);
  // circle
  ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(239,235,225,0.95)';
  ctx.fill();
  ctx.strokeStyle = '#0E131F';
  ctx.lineWidth = 2;
  ctx.stroke();
  // N
  ctx.fillStyle = '#0E131F';
  ctx.font = '700 10px "Space Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, -28);
  // sun needle (az from N clockwise; canvas 0 = +X east, N = -Y)
  const rad = (sun.az - 90) * DEG;
  const sx = Math.cos(rad) * 16, sy = Math.sin(rad) * 16;
  ctx.strokeStyle = '#FF9800';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(sx, sy); ctx.stroke();
  ctx.fillStyle = '#FF9800';
  ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#0E131F';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

export function updateHUD(project, ui) {
  const el = document.getElementById('sc_sun_info');
  if (el && ui.sun) {
    el.textContent = `sun az ${ui.sun.az.toFixed(0)}° ${cardinal(ui.sun.az)} · el ${ui.sun.el.toFixed(1)}°`;
  }
  const azEl = document.getElementById('sc_az');
  const elEl = document.getElementById('sc_el');
  const shEl = document.getElementById('sc_shdir');
  if (azEl && ui.sun) {
    azEl.textContent = `${ui.sun.az.toFixed(0)}° ${cardinal(ui.sun.az)}`;
    elEl.textContent = `${ui.sun.el.toFixed(1)}°`;
    const shAz = (ui.sun.az + 180) % 360;
    shEl.textContent = ui.sun.el < 3 ? '— (sun low)' : `${shAz.toFixed(0)}° ${cardinal(shAz)}`;
  }
  const scaleEl = document.getElementById('sc_scale_bar');
  if (scaleEl) {
    // 50 world units bar
    const px = 50 * project.ui.scale;
    scaleEl.style.width = Math.min(120, Math.max(20, px)) + 'px';
    const u = project.units === 'm' ? 'm' : 'ft';
    scaleEl.title = `50 ${u}`;
  }
}

export { COL };
