/* sc-geo.js — geometry: AABB, rotated rects, shadow projection, hits */
import { DEG } from './sc-sun.js';

/** Axis-aligned rect {x,y,w,d} (x,y = min corner). */
export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.d && a.y + a.d > b.y;
}

export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.d;
}

/** Oriented rect corners (center-based x,y = center). Returns 4 corners. */
export function obbCorners(o) {
  const hw = o.w / 2, hd = o.d / 2;
  const c = Math.cos((o.rot || 0) * DEG), s = Math.sin((o.rot || 0) * DEG);
  const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  return pts.map(([dx, dy]) => ({
    x: o.x + dx * c - dy * s,
    y: o.y + dx * s + dy * c,
  }));
}

/** Conservative AABB of an oriented rect (for broad-phase). */
export function obbAABB(o) {
  const pts = obbCorners(o);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, d: Math.max(...ys) - y0 };
}

/** SAT test between two OBBs. */
export function obbOverlap(a, b) {
  const rects = [obbCorners(a), obbCorners(b)];
  for (const poly of rects) {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const ax = poly[j].x - poly[i].x, ay = poly[j].y - poly[i].y;
      const nx = -ay, ny = ax;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const p of rects[0]) { const d = p.x * nx + p.y * ny; minA = Math.min(minA, d); maxA = Math.max(maxA, d); }
      for (const p of rects[1]) { const d = p.x * nx + p.y * ny; minB = Math.min(minB, d); maxB = Math.max(maxB, d); }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

/**
 * Project an obstacle's shadow onto the roof plane (z = roof height).
 * heightAboveRoof: obstacle top − roof plane (ft/m). Sun el in degrees, az 0=N CW.
 * Returns polygon points [{x,y}] in world coords, or null if no cast.
 */
export function castShadow(obj, roofY, sunAz, sunEl, unitsPer = 1) {
  if (sunEl < 3) return null;               // too low — ignore (avoid infinite)
  const top = (obj.floors ? obj.floors * (obj.floorH || 10) : obj.h);
  const dh = top - roofY;
  if (dh <= 0.05) return null;              // object not above roof
  const len = dh / Math.tan(sunEl * DEG);
  if (len > 400) return null;               // absurdly long — clip
  // Shadow direction = opposite of sun horizontal direction
  // Sun az: 0=N, 90=E, 180=S, 270=W. Horizontal vector toward sun:
  const sunRad = sunAz * DEG;
  const dirX = Math.sin(sunRad);   // east component
  const dirY = Math.cos(sunRad);   // north component
  // Shadow extends AWAY from sun:
  const shX = -dirX, shY = -dirY;
  // Build swept polygon: original OBB + translated OBB + side quads (convex hull of 8 pts)
  const base = obbCorners(obj);
  const tip = base.map(p => ({ x: p.x + shX * len, y: p.y + shY * len }));
  return convexHull([...base, ...tip]);
}

/** Monotone-chain convex hull. */
export function convexHull(pts) {
  if (pts.length <= 3) return pts.slice();
  const sorted = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Point-in-polygon (ray cast). */
export function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/** Distance from point to segment. */
export function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Direction cardinal label from azimuth degrees (shadow direction). */
export function cardinal(az) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(((az % 360) + 360) % 360 / 45) % 8];
}
