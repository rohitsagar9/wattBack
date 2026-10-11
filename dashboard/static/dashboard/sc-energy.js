/* sc-energy.js — transparent offline energy estimates */
import { castShadow, pointInPoly } from './sc-geo.js';
import { roofY } from './sc-world.js';
import { sunAt, SEASON_DATES } from './sc-sun.js';

/**
 * Offline irradiation proxy (kWh/m²/day) by latitude + season.
 * Not a weather API — clearly labeled ESTIMATE in UI.
 */
export function clearSkyGHI(lat, dateIso) {
  const doy = Math.round((Date.parse(dateIso) - Date.UTC(new Date(dateIso).getUTCFullYear(), 0, 0)) / 864e5);
  // simple seasonal modulation around latitude-dependent base
  const base = 4.2 + 2.2 * Math.cos((lat - 23.5) * Math.PI / 180);
  const season = 1 + 0.18 * Math.cos(2 * Math.PI * (doy - 172) / 365);
  return Math.max(2.0, base * season);;
}

/** Annual-ish unshaded fraction for a point (sample seasons × midday window). */
export function unshadedFraction(project, x, y) {
  const ry = roofY(project);
  const saved = project.sun.date;
  let good = 0, n = 0;
  for (const d of SEASON_DATES) {
    project.sun.date = d;
    for (let t = 600; t <= 960; t += 30) {
      const sun = sunAt(project, t);
      if (sun.el < 8) { n++; continue; }
      n++;
      let shaded = false;
      for (const o of project.objects) {
        const poly = castShadow(o, ry, sun.az, sun.el);
        if (poly && pointInPoly(x, y, poly)) { shaded = true; break; }
      }
      if (!shaded) good++;
    }
  }
  project.sun.date = saved;
  return n ? good / n : 1;
}

/**
 * Full layout energy report.
 * Returns {
 *   n, kwp, kwhYr, shadeLossPct, vsSuggestedPct,
 *   usableMax, perPanel: [{id, score, kwhYr}]
 * }
 */
export function energyReport(project, heat) {
  const sp = project.panelSpec;
  const n = project.panels.length;
  const kwp = n * sp.kW;
  const lat = project.location.lat;
  const avgGHI = clearSkyGHI(lat, project.sun.date); // kWh/m²/day rough

  // System derate: temp + wiring + inverter ~0.80; tilt/az orientation ~0.85–1.0
  const DERATE = 0.80;
  const perPanel = [];
  let kwhYrClear = 0, kwhYrShaded = 0;

  for (const pan of project.panels) {
    const uf = unshadedFraction(project, pan.x, pan.y);
    // orientation factor: panel az vs equator-facing
    const optAz = lat >= 0 ? 180 : 0;
    const dAz = Math.abs(((pan.az || 180) - optAz + 540) % 360 - 180);
    const orient = Math.cos(dAz * Math.PI / 180) * 0.5 + 0.5; // 0.5–1
    const tiltF = 0.85 + 0.15 * Math.cos(((pan.tilt || 10) - Math.min(30, Math.abs(lat))) * Math.PI / 180);
    // annual kWh ≈ kWp × peakSunHours × 365 × derate × orient × tiltF × uf
    // peakSunHours ≈ avgGHI × 0.85 (PSH proxy)
    const psh = avgGHI * 0.85;
    const clear = sp.kW * psh * 365 * DERATE * orient * tiltF;
    const shaded = clear * uf;
    kwhYrClear += clear;
    kwhYrShaded += shaded;
    perPanel.push({ id: pan.id, score: uf, kwhYr: shaded, clearKwhYr: clear });
  }

  const shadeLossPct = kwhYrClear > 0 ? (1 - kwhYrShaded / kwhYrClear) * 100 : 0;

  // vs suggested: recompute on a temp clone with suggestLayout would be heavy;
  // approximate: if all panels in green zone (score≥0.8), vs = 0
  const avgScore = n ? perPanel.reduce((s, p) => s + p.score, 0) / n : 0;
  const vsSuggestedPct = n ? (1 - avgScore) * 100 : 0;

  return {
    n, kwp: Math.round(kwp * 100) / 100,
    kwhYr: Math.round(kwhYrShaded),
    kwhYrClear: Math.round(kwhYrClear),
    shadeLossPct: Math.round(shadeLossPct * 10) / 10,
    vsSuggestedPct: Math.round(vsSuggestedPct * 10) / 10,
    avgScore: Math.round(avgScore * 100) / 100,
    perPanel,
    avgGHI: Math.round(avgGHI * 100) / 100,
  };
}

/** Mark which panels are currently shaded (for red render). */
export function shadedPanelIds(project) {
  const ry = roofY(project);
  const sun = sunAt(project, project.sun.timeMin);
  const out = {};
  if (sun.el < 3) {
    for (const p of project.panels) out[p.id] = true;
    return out;
  }
  const polys = [];
  for (const o of project.objects) {
    const poly = castShadow(o, ry, sun.az, sun.el);
    if (poly) polys.push(poly);
  }
  for (const pan of project.panels) {
    // sample panel center + 4 corners
    const pts = [
      { x: pan.x, y: pan.y },
      { x: pan.x - pan.w / 3, y: pan.y - pan.d / 3 },
      { x: pan.x + pan.w / 3, y: pan.y - pan.d / 3 },
      { x: pan.x - pan.w / 3, y: pan.y + pan.d / 3 },
      { x: pan.x + pan.w / 3, y: pan.y + pan.d / 3 },
    ];
    let hits = 0;
    for (const pt of pts) {
      for (const poly of polys) {
        if (pointInPoly(pt.x, pt.y, poly)) { hits++; break; }
      }
    }
    out[pan.id] = hits >= 3; // majority of sample points shaded
  }
  return out;
}
