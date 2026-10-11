/* sc-recommend.js — solar zone heatmap + Suggest engine */
import { castShadow, pointInPoly } from './sc-geo.js';
import { terraceRect, roofY } from './sc-world.js';
import { placePanel } from './sc-panels.js';
import { sunAt, SEASON_DATES } from './sc-sun.js';

/**
 * Compute per-cell solar access score on the usable terrace.
 * score = fraction of sampled (date, time) where the cell is NOT in shadow.
 * Returns [{x, y, score}] at 1-ft (or 0.5-m) resolution — capped cell count.
 */
export function computeHeat(project, opts = {}) {
  const tr = terraceRect(project);
  const sb = project.terrace.setback;
  const minX = tr.x + sb, minY = tr.y + sb;
  const maxX = tr.x + tr.w - sb, maxY = tr.y + tr.d - sb;
  const cell = project.units === 'm' ? 0.5 : 1;
  const dates = opts.dates || SEASON_DATES;
  // Sample times 8:00–16:00 every 30 min (8 samples/day × 4 dates = 32)
  const times = [];
  for (let t = 480; t <= 960; t += 30) times.push(t);

  const ry = roofY(project);
  const obstacles = project.objects; // all cast

  // Precompute shadows per (date, time)
  const shadowSets = [];
  const savedDate = project.sun.date;
  for (const d of dates) {
    project.sun.date = d;
    for (const t of times) {
      const sun = sunAt(project, t);
      if (sun.el < 5) continue;
      const polys = [];
      for (const o of obstacles) {
        const poly = castShadow(o, ry, sun.az, sun.el);
        if (poly) polys.push(poly);
      }
      shadowSets.push(polys);
    }
  }
  project.sun.date = savedDate;

  const nS = shadowSets.length || 1;
  const cells = [];
  const maxCells = 8000;
  const step = Math.max(cell, Math.sqrt((maxX - minX) * (maxY - minY) / maxCells));
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      let unshaded = 0;
      for (const polys of shadowSets) {
        let hit = false;
        for (const poly of polys) {
          if (pointInPoly(x, y, poly)) { hit = true; break; }
        }
        if (!hit) unshaded++;
      }
      cells.push({ x, y, score: unshaded / nS });
    }
  }
  return cells;
}

/**
 * Suggest a panel layout: greedy pack into highest-score free zones.
 * Mutates project.panels. Returns { placed: n, avgScore, skipped }.
 */
export function suggestLayout(project, heat) {
  // clear existing
  project.panels = [];
  if (!heat || !heat.length) return { placed: 0, avgScore: 0, skipped: 0 };

  const sp = project.panelSpec;
  const tr = terraceRect(project);
  const sb = project.terrace.setback;
  const gap = project.units === 'm' ? 0.5 : 1.5; // row spacing for tilt

  // Sort heat cells by score desc
  const sorted = heat.slice().sort((a, b) => b.score - a.score);

  // Candidate panel centers: snap to grid, try each high-score cell
  const tried = new Set();
  let placed = 0, scoreSum = 0, skipped = 0;
  const cell = project.units === 'm' ? 0.5 : 1;

  // Determine panel rotation: prefer landscape along longer roof dimension
  const rot = tr.w >= tr.d ? 0 : 90;

  for (const c of sorted) {
    if (placed >= 200) break;
    const key = `${Math.round(c.x / cell)},${Math.round(c.y / cell)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    if (c.score < 0.35) continue; // don't place in deep shade
    const r = placePanel(project, c.x, c.y, rot);
    if (r.ok) {
      placed++;
      scoreSum += c.score;
    } else {
      skipped++;
    }
  }
  return { placed, avgScore: placed ? scoreSum / placed : 0, skipped };
}

/** Zone label for a panel given heat lookup. */
export function scoreAt(heat, x, y) {
  if (!heat || !heat.length) return null;
  let best = null, bd = Infinity;
  for (const c of heat) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best ? best.score : null;
}
