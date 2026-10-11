/* sc-world.js — project document, units, persistence, undo */
const LS_KEY = 'solarcraft.v1';
const UNDO_MAX = 50;

let _id = 1;
export function uid() { return 'o' + (_id++); }

export function defaultProject(over = {}) {
  return {
    name: 'My rooftop',
    units: 'ft',
    location: { lat: 17.7038, lng: 83.2986, tzOffset: 5.5 },
    building: {
      type: 'house', w: 33, d: 66, floors: 2, floorH: 10, orientationDeg: 180,
      // building footprint placed at world origin (SW corner at 0,0)
      x: 0, y: 0,
    },
    terrace: { inset: 1, setback: 0.5 },
    objects: [],   // {id, kind, x,y (center), w,d, h, rot, floors?, floorH?}
    panels: [],    // {id, x,y (center), w,d, tilt, az, arrayId?}
    panelSpec: { w: 3.3, d: 5.5, kW: 0.4, tilt: 10, az: 180 },
    sun: { date: new Date().toISOString().slice(0, 10), timeMin: 720 },
    ui: { scale: 8, panX: 80, panY: 40 },
    meta: { created: Date.now(), v: 1 },
    ...over,
  };
}

/** Usable terrace rect (inset from building edges). */
export function terraceRect(p) {
  const b = p.building, i = p.terrace.inset;
  return { x: b.x + i, y: b.y + i, w: b.w - 2 * i, d: b.d - 2 * i };
}

/** Building height in units. */
export function buildingHeight(p) {
  return p.building.floors * p.building.floorH;
}

export function roofY(p) { return buildingHeight(p); }

export function hasTank(p) {
  return p.objects.some(o => o.kind === 'tank');
}

export function tankObjects(p) {
  return p.objects.filter(o => o.kind === 'tank');
}

/** Clone for undo snapshots. */
export function clone(p) { return JSON.parse(JSON.stringify(p)); }

/* ── Undo stack ── */
export class History {
  constructor(limit = UNDO_MAX) {
    this.limit = limit;
    this.past = [];
    this.future = [];
  }
  push(project) {
    this.past.push(clone(project));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(clone(current));
    return this.past.pop();
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(clone(current));
    return this.future.pop();
  }
  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
}

/* ── localStorage ── */
export function saveLocal(project) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(project));
    return true;
  } catch { return false; }
}

export function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    // sanity
    if (!p.building || !p.location) return null;
    return p;
  } catch { return null; }
}

export function hasLocal() {
  try { return !!localStorage.getItem(LS_KEY); } catch { return false; }
}

/* ── World ↔ screen ── */
export function worldToScreen(p, wx, wy) {
  const s = p.ui.scale;
  return { x: wx * s + p.ui.panX, y: -wy * s + p.ui.panY };
}

export function screenToWorld(p, sx, sy) {
  const s = p.ui.scale;
  return { x: (sx - p.ui.panX) / s, y: -(sy - p.ui.panY) / s };
}

/** Zoom around a screen anchor. */
export function zoomAt(p, sx, sy, factor) {
  const before = screenToWorld(p, sx, sy);
  p.ui.scale = Math.max(2, Math.min(48, p.ui.scale * factor));
  const after = screenToWorld(p, sx, sy);
  p.ui.panX += (after.x - before.x) * p.ui.scale;
  p.ui.panY -= (after.y - before.y) * p.ui.scale;
}

/** Fit building into viewport with padding. */
export function fitView(p, vw, vh, pad = 60) {
  const b = p.building;
  // include some margin around building for neighbors
  const ext = Math.max(b.w, b.d) * 1.6;
  const scale = Math.min((vw - pad * 2) / ext, (vh - pad * 2) / ext);
  p.ui.scale = Math.max(3, Math.min(30, scale));
  // center building center on canvas
  const cx = b.x + b.w / 2, cy = b.y + b.d / 2;
  p.ui.panX = vw / 2 - cx * p.ui.scale;
  p.ui.panY = vh / 2 + cy * p.ui.scale;
}

/** Format length with units. */
export function fmt(n, units) {
  const u = units === 'm' ? 'm' : 'ft';
  return (Math.round(n * 10) / 10) + ' ' + u;
}

export function areaLabel(w, d, units) {
  const u = units === 'm' ? 'm²' : 'ft²';
  return (Math.round(w * d)) + ' ' + u;
}
