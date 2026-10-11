/* sc-panels.js — panel placement, collision, rows */
import { obbOverlap, obbAABB } from './sc-geo.js';
import { terraceRect, roofY, uid } from './sc-world.js';

/** All solid occupancy on roof (excluding given panel id). */
function roofSolids(project, excludeId) {
  const tr = terraceRect(project);
  const solids = [];
  for (const o of project.objects) {
    if (o.kind === 'neighbor') continue;
    solids.push(o);
  }
  for (const pan of project.panels) {
    if (pan.id !== excludeId) solids.push(pan);
  }
  return { solids, tr, sb: project.terrace.setback };
}

/** Can a panel at (x,y,rot) fit without overlap? */
export function canPlacePanel(project, cand, excludeId = null) {
  const { solids, tr, sb } = roofSolids(project, excludeId);
  // bounds: inside terrace inset by setback
  const minX = tr.x + sb, minY = tr.y + sb;
  const maxX = tr.x + tr.w - sb, maxY = tr.y + tr.d - sb;
  const aabb = obbAABB(cand);
  if (aabb.x < minX - 0.01 || aabb.y < minY - 0.1 ||
      aabb.x + aabb.w > maxX + 0.01 || aabb.y + aabb.d > maxY + 0.01) {
    return { ok: false, why: 'outside usable roof' };
  }
  for (const s of solids) {
    if (obbOverlap(cand, s)) {
      return { ok: false, why: s.kind === 'tank' ? 'hits water tank' :
        s.kind === 'tree' ? 'hits tree' :
        s.kind === 'mumty' ? 'hits mumty' :
        s.kind === 'wall' ? 'hits wall' :
        s.kind === 'pole' ? 'hits pole' : 'overlaps another panel' };
    }
  }
  return { ok: true };
}

/** Place a panel; returns new panel or null. */
export function placePanel(project, x, y, rot = 0, spec = null) {
  const sp = spec || project.panelSpec;
  const cand = { id: uid(), x, y, w: sp.w, d: sp.d, rot, tilt: sp.tilt, az: sp.az };
  const check = canPlacePanel(project, cand);
  if (!check.ok) return { ok: false, why: check.why, panel: null };
  project.panels.push(cand);
  return { ok: true, panel: cand };
}

/** Place a horizontal or vertical row of n panels starting at (x,y) center of first. */
export function placeRow(project, x, y, n, gap = 0.15, rot = 0) {
  const sp = project.panelSpec;
  const placed = [];
  const stepX = (rot % 180 === 0) ? sp.w + gap : sp.d + gap;
  let cx = x - ((n - 1) * stepX) / 2;
  for (let i = 0; i < n; i++) {
    const r = placePanel(project, cx + i * stepX, y, rot);
    if (!r.ok) {
      // rollback partial
      for (const p of placed) {
        const idx = project.panels.indexOf(p);
        if (idx >= 0) project.panels.splice(idx, 1);
      }
      return { ok: false, why: r.why, placed };
    }
    placed.push(r.panel);
  }
  return { ok: true, placed };
}

/** Max panels that could fit in remaining free area (rough packing). */
export function maxPanelsEstimate(project) {
  const sp = project.panelSpec;
  const tr = terraceRect(project);
  const sb = project.terrace.setback;
  const freeW = tr.w - 2 * sb;
  const freeD = tr.d - 2 * sb;
  if (freeW <= sp.w || freeD <= sp.d) return 0;
  const cols = Math.floor(freeW / (sp.w + 0.15));
  const rows = Math.floor(freeD / (sp.d + 0.15));
  let gross = cols * rows;
  // subtract occupied
  const areaOcc = project.objects.filter(o => o.kind !== 'neighbor')
    .reduce((s, o) => s + o.w * o.d, 0)
    + project.panels.reduce((s, o) => s + o.w * o.d, 0);
  const panelArea = sp.w * sp.d;
  const freeArea = freeW * freeD - areaOcc;
  const byArea = Math.max(0, Math.floor(freeArea / (panelArea * 1.15)));
  return Math.min(gross, byArea);
}

/** Remaining free area (ft²/m²). */
export function remainingArea(project) {
  const tr = terraceRect(project);
  const sb = project.terrace.setback;
  const free = (tr.w - 2 * sb) * (tr.d - 2 * sb);
  const occ = project.objects.filter(o => o.kind !== 'neighbor')
    .reduce((s, o) => s + o.w * o.d, 0)
    + project.panels.reduce((s, o) => s + o.w * o.d, 0);
  return Math.max(0, free - occ);
}

export function usableArea(project) {
  const tr = terraceRect(project);
  const sb = project.terrace.setback;
  return (tr.w - 2 * sb) * (tr.d - 2 * sb);
}
