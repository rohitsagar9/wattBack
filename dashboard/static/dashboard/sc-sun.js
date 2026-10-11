/* sc-sun.js — NOAA solar position + day sampling (pure, no DOM) */
export const DEG = Math.PI / 180;

export function dayOfYear(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
}

/** NOAA solar position. Returns {az, el} in degrees. el < 0 = below horizon. */
export function solarPos(doy, hourUTC, lat, lng) {
  const g = 2 * Math.PI / 365 * (doy - 1 + (hourUTC - 12) / 24);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
    - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
    - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const latR = lat * DEG;
  const ha = ((hourUTC * 60 + eq + 4 * lng) / 4 - 180) * DEG;
  const cosZ = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const el = 90 - Math.acos(Math.max(-1, Math.min(1, cosZ))) / DEG;
  const az = (Math.atan2(-Math.sin(ha), Math.tan(decl) * Math.cos(latR) - Math.sin(latR) * Math.cos(ha)) / DEG + 360) % 360;
  return { az, el };
}

/** Local wall-clock time in minutes → UTC hour float, given tz offset hours. */
export function minutesToUTCHour(timeMin, tzOffset) {
  return (((timeMin / 60 - tzOffset) % 24) + 24) % 24;
}

/** Sun az/el for a project at given local time (minutes) and date. */
export function sunAt(project, timeMin) {
  const doy = dayOfYear(project.sun.date);
  const utcH = minutesToUTCHour(timeMin, project.location.tzOffset);
  return solarPos(doy, utcH, project.location.lat, project.location.lng);
}

/** Sample sun elevations across a day (every 15 min from 5–19 local). Returns [{timeMin, az, el}]. */
export function sunDaySamples(project) {
  const out = [];
  for (let t = 300; t <= 1140; t += 15) {
    const s = sunAt(project, t);
    out.push({ timeMin: t, az: s.az, el: s.el });
  }
  return out;
}

/** Fraction of peak window (10:00–14:00) where sun is above minEl. Used for annual-ish score. */
export function peakSunFraction(project, dateIso) {
  const saved = project.sun.date;
  project.sun.date = dateIso;
  let good = 0, n = 0;
  for (let t = 600; t <= 840; t += 15) {
    const { el } = sunAt(project, t);
    n++;
    if (el >= 15) good++;
  }
  project.sun.date = saved;
  return n ? good / n : 0;
}

/** Sampled unshaded fraction for a roof point across seasons (Mar/Jun/Sep/Dec solstices-ish). */
export const SEASON_DATES = ['2026-03-20', '2026-06-21', '2026-09-22', '2026-12-21'];
