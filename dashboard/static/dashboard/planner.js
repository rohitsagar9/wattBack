/* planner.js — SolarCraft entry: tools, interaction, wizard, persistence */
import { sunAt } from './sc-sun.js';
import {
  defaultProject, terraceRect, roofY, buildingHeight, hasTank,
  History, saveLocal, loadLocal, hasLocal,
  worldToScreen, screenToWorld, zoomAt, fitView, clone, uid,
  fmt, areaLabel,
} from './sc-world.js';
import { draw, updateHUD } from './sc-render.js';
import {
  obbCorners, obbAABB, obbOverlap, aabbOverlap, pointInRect, castShadow, cardinal as card,
} from './sc-geo.js';
import {
  canPlacePanel, placePanel, placeRow, maxPanelsEstimate, remainingArea, usableArea,
} from './sc-panels.js';
import { computeHeat, suggestLayout, scoreAt } from './sc-recommend.js';
import { energyReport, shadedPanelIds } from './sc-energy.js';

const $ = (id) => document.getElementById(id);
const canvas = $('sc_canvas');
const ctx = canvas.getContext('2d');

/* ── state ── */
let project = null;
const history = new History();
const ui = {
  tool: 'select',
  selected: null,
  ghost: null,
  ghostValid: true,
  sun: { az: 180, el: 60 },
  heat: null,
  heatDirty: true,
  panelShade: {},
  shadowsOn: true,
  dragging: null,      // {obj, ox, oy, startX, startY}
  panning: false,
  panStart: null,
  measurePts: [],
  playing: false,
  playTimer: null,
  dirty: true,
};

/* ── boot ── */
function boot() {
  wireToolbar();
  wireTop();
  wireBottom();
  wireProps();
  wireCanvas();
  window.addEventListener('resize', () => { ui.dirty = true; });

  const saved = loadLocal();
  if (saved) {
    project = saved;
    $('sc_wizard').hidden = true;
    afterProject();
  } else {
    // show wizard; project created on start
    $('sc_wizard').hidden = false;
  }
  $('w_start').addEventListener('click', startWizard);
  $('w_units').addEventListener('change', () => {
    const u = $('w_units').value === 'm' ? 'm' : 'ft';
    document.querySelectorAll('[data-unit]').forEach(el => { el.textContent = u; });
    // sensible metric defaults if switching and still at imperial defaults
    if (u === 'm' && $('w_w').value === '33') {
      $('w_w').value = '10';
      $('w_d').value = '20';
      $('w_floorh').value = '3';
      $('w_pw').value = '1.0';
      $('w_pd').value = '1.7';
      $('w_setback').value = '0.15';
      $('w_inset').value = '0.3';
    }
  });
  requestAnimationFrame(loop);
}

function startWizard() {
  const units = $('w_units').value;
  const w = parseFloat($('w_w').value) || 33;
  const d = parseFloat($('w_d').value) || 66;
  project = defaultProject({
    name: $('w_name').value || 'My rooftop',
    units,
    location: {
      lat: parseFloat($('w_lat').value) || 17.7038,
      lng: parseFloat($('w_lng').value) || 83.2986,
      tzOffset: parseFloat($('w_tz').value) || 5.5,
    },
    building: {
      type: $('w_type').value,
      w, d,
      floors: parseInt($('w_floors').value) || 2,
      floorH: parseFloat($('w_floorh').value) || 10,
      orientationDeg: parseFloat($('w_orient').value) || 180,
      x: 0, y: 0,
    },
    terrace: {
      inset: parseFloat($('w_inset').value) || 1,
      setback: parseFloat($('w_setback').value) || 0.5,
    },
    panelSpec: {
      w: parseFloat($('w_pw').value) || 3.3,
      d: parseFloat($('w_pd').value) || 5.5,
      kW: parseFloat($('w_pk').value) || 0.4,
      tilt: parseFloat($('w_ptilt').value) || 10,
      az: parseFloat($('w_orient').value) || 180,
    },
  });
  $('sc_wizard').hidden = true;
  history.push(project);
  afterProject();
  // auto-place a default tank so users see the pattern (still editable)
  seedDefaultTank();
  showBanner('Model created — place a water tank if you removed it, then add panels.', 'ok', 4000);
}

function seedDefaultTank() {
  if (hasTank(project)) return;
  const tr = terraceRect(project);
  // corner tank ~4×4 ft
  const size = project.units === 'm' ? 1.2 : 4;
  const x = tr.x + tr.w - size;
  const y = tr.y + tr.d - size;
  project.objects.push({
    id: uid(), kind: 'tank',
    x, y, w: size, d: size, h: project.units === 'm' ? 1.5 : 5, rot: 0,
  });
  history.push(project);
  ui.heatDirty = true;
  ui.dirty = true;
}

function afterProject() {
  const vw = canvas.clientWidth || 800, vh = canvas.clientHeight || 600;
  fitView(project, vw, vh);
  updateTop();
  ui.heatDirty = true;
  ui.dirty = true;
  refreshSun();
}

/* ── loop ── */
function loop() {
  if (!project) {
    // wizard not completed yet — keep the rAF chain alive, draw nothing
    requestAnimationFrame(loop);
    return;
  }
  if (ui.heatDirty) {
    try {
      ui.heat = computeHeat(project);
      ui.heatDirty = false;
    } catch (e) {
      console.warn('computeHeat failed', e);
    }
    ui.dirty = true;
  }
  if (ui.dirty) {
    try {
      ui.panelShade = shadedPanelIds(project);
      draw(ctx, canvas, project, ui);
      updateHUD(project, ui);
      updateEnergy();
    } catch (e) {
      console.error('draw failed', e);
    }
    ui.dirty = false;
  }
  requestAnimationFrame(loop);
}

function markDirty() { ui.dirty = true; }
function markHeat() { ui.heatDirty = true; ui.dirty = true; }

/* ── sun ── */
function refreshSun() {
  if (!project) return;
  ui.sun = sunAt(project, project.sun.timeMin);
  markDirty();
}

/* ── toolbar ── */
function wireToolbar() {
  document.querySelectorAll('.sc-tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sc-tool[data-tool]').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      ui.tool = btn.dataset.tool;
      ui.ghost = null;
      ui.measurePts = [];
      if (ui.tool !== 'select') ui.selected = null;
      updateProps();
      markDirty();
    });
  });
  $('sc_suggest').addEventListener('click', onSuggest);
  $('sc_clear_panels').addEventListener('click', () => {
    if (!project.panels.length) return;
    history.push(project);
    project.panels = [];
    markHeat();
    showBanner('Panels cleared', 'ok', 1500);
  });
}

/* ── top bar ── */
function wireTop() {
  $('sc_undo').addEventListener('click', doUndo);
  $('sc_redo').addEventListener('click', doRedo);
  $('sc_save').addEventListener('click', () => {
    const ok = saveLocal(project);
    showBanner(ok ? 'Saved to browser' : 'Save failed', ok ? 'ok' : '', 2000);
  });
  $('sc_load').addEventListener('click', () => {
    const p = loadLocal();
    if (p) {
      history.push(project);
      project = p;
      afterProject();
      showBanner('Loaded saved project', 'ok', 2000);
    } else showBanner('No saved project', '', 2000);
  });
  $('sc_new').addEventListener('click', () => {
    $('sc_wizard').hidden = false;
  });
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); doUndo(); }
    else if (e.ctrlKey && e.key === 'y') { e.preventDefault(); doRedo(); }
    else if (e.key === 'v' || e.key === 'V') selectTool('select');
    else if (e.key === 'm' || e.key === 'M') selectTool('measure');
    else if (e.key === 'p' || e.key === 'P') selectTool('panel');
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    else if (e.key === 'Escape') {
      ui.selected = null; ui.ghost = null; ui.measurePts = [];
      updateProps(); markDirty();
    }
    else if (e.key === 'r' || e.key === 'R') rotateSelected();
  });
}

function selectTool(t) {
  const btn = document.querySelector(`.sc-tool[data-tool="${t}"]`);
  if (btn) btn.click();
}

function doUndo() {
  const prev = history.undo(project);
  if (prev) {
    project = prev;
    ui.selected = null;
    updateProps(); updateTop(); markHeat();
  }
}
function doRedo() {
  const next = history.redo(project);
  if (next) {
    project = next;
    ui.selected = null;
    updateProps(); updateTop(); markHeat();
  }
}

function updateTop() {
  $('sc_proj_name').textContent = project.name;
  const b = project.building;
  const u = project.units === 'm' ? 'm' : 'ft';
  $('sc_dims').textContent = `${b.w}×${b.d} ${u} · ${b.floors} floors · ${b.type}`;
}

/* ── bottom ── */
function wireBottom() {
  const dateI = $('sc_date'), timeR = $('sc_time'), timeL = $('sc_time_lab');
  dateI.addEventListener('change', () => {
    project.sun.date = dateI.value;
    refreshSun(); markHeat();
  });
  timeR.addEventListener('input', () => {
    project.sun.timeMin = parseInt(timeR.value);
    timeL.textContent = fmtTime(project.sun.timeMin);
    refreshSun();
  });
  $('sc_play').addEventListener('click', togglePlay);
}

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function togglePlay() {
  ui.playing = !ui.playing;
  $('sc_play').classList.toggle('on', ui.playing);
  $('sc_play').textContent = ui.playing ? '⏸' : '▶ day';
  if (ui.playing) {
    ui.playTimer = setInterval(() => {
      project.sun.timeMin = (project.sun.timeMin + 15) % 1140;
      if (project.sun.timeMin < 300) project.sun.timeMin = 300;
      $('sc_time').value = project.sun.timeMin;
      $('sc_time_lab').textContent = fmtTime(project.sun.timeMin);
      refreshSun();
    }, 120);
  } else {
    clearInterval(ui.playTimer);
  }
}

/* ── props panel ── */
function wireProps() {
  const fields = ['p_x', 'p_y', 'p_w', 'p_d', 'p_h', 'p_rot', 'p_floors'];
  fields.forEach(id => {
    $(id).addEventListener('change', onPropChange);
  });
  $('p_delete').addEventListener('click', deleteSelected);
}

function onPropChange() {
  const obj = findSelected();
  if (!obj) return;
  const isBuilding = ui.selected === 'building';
  history.push(project);
  obj.x = parseFloat($('p_x').value) || obj.x;
  obj.y = parseFloat($('p_y').value) || obj.y;
  if ($('p_w').value) obj.w = Math.max(1, parseFloat($('p_w').value) || obj.w);
  if ($('p_d').value) obj.d = Math.max(1, parseFloat($('p_d').value) || obj.d);
  if (!isBuilding && $('p_h').value) obj.h = Math.max(0.3, parseFloat($('p_h').value) || obj.h);
  if (!isBuilding) obj.rot = parseFloat($('p_rot').value) || 0;
  if ($('p_floors').value && obj.floors != null) {
    obj.floors = Math.max(1, parseInt($('p_floors').value) || obj.floors);
  }
  if (!isBuilding && project.panels.includes(obj)) {
    const check = canPlacePanel(project, obj, obj.id);
    if (!check.ok) showBanner('Invalid: ' + check.why, '', 2500);
  }
  markHeat();
}

function findSelected() {
  if (!ui.selected) return null;
  if (ui.selected === 'building') {
    const b = project.building;
    b.id = 'building';
    return b;
  }
  return project.objects.find(o => o.id === ui.selected) ||
         project.panels.find(o => o.id === ui.selected);
}

function updateProps() {
  const obj = findSelected();
  const form = $('sc_sel_form'), none = $('sc_sel_none');
  if (!obj) {
    form.hidden = true; none.hidden = false;
    $('sc_sel_title').textContent = 'Properties';
    $('p_delete').disabled = false;
    return;
  }
  form.hidden = false; none.hidden = true;
  const isPanel = project.panels.includes(obj);
  const isBuilding = ui.selected === 'building';
  $('sc_sel_title').textContent = isBuilding ? 'Building' : isPanel ? 'Panel' : 'Object';
  $('p_kind').textContent = isBuilding ? project.building.type : isPanel ? 'PV module' : obj.kind;
  $('p_x').value = obj.x.toFixed(1);
  $('p_y').value = obj.y.toFixed(1);
  $('p_w').value = obj.w.toFixed(1);
  $('p_d').value = obj.d.toFixed(1);
  $('p_h').value = (obj.h || 0).toFixed(1);
  $('p_rot').value = obj.rot || 0;
  const fr = $('p_floors_row');
  if (obj.floors != null) {
    fr.hidden = false;
    $('p_floors').value = obj.floors;
  } else {
    fr.hidden = true;
  }
  $('p_delete').disabled = isBuilding; // can't delete the house
}

function deleteSelected() {
  if (!ui.selected || ui.selected === 'building') return;
  history.push(project);
  const oi = project.objects.findIndex(o => o.id === ui.selected);
  if (oi >= 0) project.objects.splice(oi, 1);
  const pi = project.panels.findIndex(o => o.id === ui.selected);
  if (pi >= 0) project.panels.splice(pi, 1);
  ui.selected = null;
  updateProps(); markHeat();
}

function rotateSelected() {
  const obj = findSelected();
  if (!obj) return;
  history.push(project);
  obj.rot = ((obj.rot || 0) + 90) % 360;
  updateProps(); markHeat();
}

/* ── canvas interaction ── */
function wireCanvas() {
  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
}

function localXY(e) {
  const r = canvas.getBoundingClientRect();
  return { sx: e.clientX - r.left, sy: e.clientY - r.top };
}

function onDown(e) {
  if (!project) return;
  const { sx, sy } = localXY(e);
  const w = screenToWorld(project, sx, sy);
  const mid = e.button === 1 || (e.button === 0 && e.altKey);

  if (mid || ui.tool === 'pan') {
    ui.panning = true;
    ui.panStart = { sx, sy, panX: project.ui.panX, panY: project.ui.panY };
    canvas.classList.add('panning');
    return;
  }

  switch (ui.tool) {
    case 'select': {
      const hit = hitTest(w.x, w.y);
      ui.selected = hit ? hit.id : null;
      updateProps();
      if (hit) {
        history.push(project);
        if (hit.id === 'building') {
          ui.dragging = {
            obj: hit, ox: w.x - hit.x, oy: w.y - hit.y,
            startX: hit.x, startY: hit.y, moved: false, translateAll: true,
          };
        } else {
          ui.dragging = {
            obj: hit, ox: w.x - hit.x, oy: w.y - hit.y,
            startX: hit.x, startY: hit.y, moved: false,
          };
        }
      }
      markDirty();
      break;
    }
    case 'building': {
      // click selects + drags the whole house (building + contents move together)
      const b = project.building;
      ui.selected = 'building';
      updateProps();
      history.push(project);
      ui.dragging = {
        obj: b, ox: w.x - b.x, oy: w.y - b.y,
        startX: b.x, startY: b.y, moved: false, translateAll: true,
      };
      markDirty();
      break;
    }
    case 'measure': {
      ui.measurePts.push({ x: w.x, y: w.y });
      if (ui.measurePts.length > 2) ui.measurePts = [{ x: w.x, y: w.y }];
      markDirty();
      break;
    }
    case 'delete': {
      const hit = hitTest(w.x, w.y);
      if (hit) {
        ui.selected = hit.id;
        deleteSelected();
      }
      break;
    }
    case 'tank':
    case 'tree':
    case 'mumty':
    case 'wall':
    case 'pole':
    case 'neighbor': {
      placeObject(ui.tool, w.x, w.y);
      break;
    }
    case 'panel': {
      const r = placePanel(project, snap(w.x), snap(w.y), 0);
      if (r.ok) {
        history.push(project);
        markHeat();
        showBanner('Panel placed', 'ok', 1200);
      } else {
        showBanner('Cannot place: ' + r.why, '', 2000);
      }
      break;
    }
    case 'row': {
      const n = 5;
      const r = placeRow(project, snap(w.x), snap(w.y), n);
      if (r.ok) {
        history.push(project);
        markHeat();
        showBanner(`Row of ${n} placed`, 'ok', 1500);
      } else {
        showBanner('Row failed: ' + r.why, '', 2500);
      }
      break;
    }
  }
}

function snap(v) {
  const g = project.units === 'm' ? 0.5 : 1;
  return Math.round(v / g) * g;
}

function onMove(e) {
  if (!project) return;
  const { sx, sy } = localXY(e);
  const w = screenToWorld(project, sx, sy);

  if (ui.panning && ui.panStart) {
    project.ui.panX = ui.panStart.panX + (sx - ui.panStart.sx);
    project.ui.panY = ui.panStart.panY + (sy - ui.panStart.sy);
    markDirty();
    return;
  }

  // cursor info
  const ci = $('sc_cursor_info');
  if (ci) ci.textContent = `${w.x.toFixed(1)}, ${w.y.toFixed(1)} ${project.units}`;

  if (ui.dragging) {
    const { obj, ox, oy, translateAll } = ui.dragging;
    if (translateAll) {
      // move building AND everything on it (keeps layout valid)
      const nx = snap(w.x - ox), ny = snap(w.y - oy);
      const dx = nx - obj.x, dy = ny - obj.y;
      obj.x = nx; obj.y = ny;
      if (dx || dy) {
        for (const o of project.objects) { o.x += dx; o.y += dy; }
        for (const pa of project.panels) { pa.x += dx; pa.y += dy; }
      }
    } else {
      obj.x = snap(w.x - ox);
      obj.y = snap(w.y - oy);
    }
    ui.dragging.moved = true;
    markDirty();
    return;
  }

  // ghost for placement tools
  const placeKinds = ['tank', 'tree', 'mumty', 'wall', 'pole', 'neighbor', 'panel'];
  if (placeKinds.includes(ui.tool)) {
    const size = defaultSize(ui.tool, project);
    ui.ghost = {
      id: 'ghost', kind: ui.tool,
      x: snap(w.x), y: snap(w.y),
      w: size.w, d: size.d, h: size.h, rot: 0,
      floors: ui.tool === 'neighbor' ? 3 : undefined,
      floorH: ui.tool === 'neighbor' ? 10 : undefined,
    };
    if (ui.tool === 'panel') {
      ui.ghostValid = canPlacePanel(project, ui.ghost).ok;
    } else {
      ui.ghostValid = true;
    }
    markDirty();
  } else {
    if (ui.ghost) { ui.ghost = null; markDirty(); }
  }
}

function onUp(e) {
  if (ui.panning) {
    ui.panning = false;
    canvas.classList.remove('panning');
  }
  if (ui.dragging) {
    const { obj, startX, startY } = ui.dragging;
    if (obj.x !== startX || obj.y !== startY) {
      // validate panels
      if (project.panels.includes(obj)) {
        const check = canPlacePanel(project, obj, obj.id);
        if (!check.ok) {
          obj.x = startX; obj.y = startY;
          showBanner('Snap back: ' + check.why, '', 2000);
        }
      }
      markHeat();
      updateProps();
    }
    ui.dragging = null;
  }
}

function onWheel(e) {
  if (!project) return;
  e.preventDefault();
  const { sx, sy } = localXY(e);
  const factor = e.deltaY < 0 ? 1.1 : 0.9;
  zoomAt(project, sx, sy, factor);
  markDirty();
}

function hitTest(wx, wy) {
  // panels first (on top)
  for (let i = project.panels.length - 1; i >= 0; i--) {
    const p = project.panels[i];
    const aabb = obbAABB(p);
    if (pointInRect(wx, wy, aabb)) {
      const c = obbCorners(p);
      if (pointInPolyLocal(wx, wy, c)) return p;
    }
  }
  for (let i = project.objects.length - 1; i >= 0; i--) {
    const o = project.objects[i];
    const aabb = obbAABB(o);
    if (pointInRect(wx, wy, aabb)) {
      const c = obbCorners(o);
      if (pointInPolyLocal(wx, wy, c)) return o;
    }
  }
  // building (corner-based rect) — lowest priority
  const b = project.building;
  if (pointInRect(wx, wy, { x: b.x, y: b.y, w: b.w, d: b.d })) {
    b.id = 'building';
    return b;
  }
  return null;
}

function pointInPolyLocal(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/* ── place objects ── */
function defaultSize(kind, p) {
  const u = p.units === 'm' ? 1 : 3.3; // rough foot scale
  switch (kind) {
    case 'tank': return { w: 4 * (p.units === 'm' ? 0.3 : 1), d: 4 * (p.units === 'm' ? 0.3 : 1), h: 5 };
    case 'tree': return { w: 6, d: 6, h: 12 };
    case 'mumty': return { w: 8, d: 8, h: 10 };
    case 'wall': return { w: 20, d: 1.5, h: 6 };
    case 'pole': return { w: 1, d: 1, h: 15 };
    case 'neighbor': return { w: 25, d: 25, h: 30 };
    default: return { w: 4, d: 4, h: 5 };
  }
}

function placeObject(kind, wx, wy) {
  if (!hasTank(project) && kind !== 'tank' && project.objects.filter(o => o.kind !== 'tank').length === 0) {
    // first object should be tank — soft nudge
    showBanner('Tip: place the water tank first (required)', 'warn', 3000);
  }
  const size = defaultSize(kind, project);
  history.push(project);
  const obj = {
    id: uid(), kind,
    x: snap(wx), y: snap(wy),
    w: size.w, d: size.d, h: size.h, rot: 0,
  };
  if (kind === 'neighbor') {
    obj.floors = 3;
    obj.floorH = 10;
    obj.h = 30;
  }
  project.objects.push(obj);
  ui.selected = obj.id;
  updateProps();
  markHeat();
  if (kind === 'tank') {
    showBanner('Water tank placed ✓', 'ok', 1500);
  }
}

/* ── suggest ── */
function onSuggest() {
  if (!hasTank(project)) {
    showBanner('Place a water tank before running suggestions', '', 3000);
    return;
  }
  history.push(project);
  if (!ui.heat) ui.heat = computeHeat(project);
  const r = suggestLayout(project, ui.heat);
  markHeat();
  updateProps();
  if (r.placed > 0) {
    showBanner(`Suggested ${r.placed} panels · avg sun ${(r.avgScore * 100).toFixed(0)}%`, 'ok', 3500);
  } else {
    showBanner('No viable panel zones found — check obstacles / orientation', '', 3500);
  }
}

/* ── energy UI ── */
function updateEnergy() {
  if (!project) return;
  const rep = energyReport(project, ui.heat);
  $('e_n').textContent = rep.n;
  $('e_kwp').textContent = rep.kwp.toFixed(2);
  $('e_kwh').textContent = rep.kwhYr ? rep.kwhYr.toLocaleString() : '—';
  $('e_loss').textContent = rep.n ? rep.shadeLossPct.toFixed(1) + '%' : '—';
  $('e_vs').textContent = rep.n ? (rep.avgScore >= 0.8 ? 'on par' : `+${rep.vsSuggestedPct.toFixed(0)}% if better`) : '—';
  const ua = usableArea(project);
  const ra = remainingArea(project);
  $('e_area').textContent = areaLabel(
    terraceRect(project).w - 2 * project.terrace.setback,
    terraceRect(project).d - 2 * project.terrace.setback,
    project.units);
  $('e_free').textContent = areaLabel(Math.sqrt(ra), Math.sqrt(ra), project.units) + ' free';
  $('e_max').textContent = maxPanelsEstimate(project);
}

/* ── banner ── */
let bannerTimer = null;
function showBanner(msg, cls = '', ms = 2500) {
  const el = $('sc_banner');
  el.textContent = msg;
  el.className = cls || '';
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
}

boot();
