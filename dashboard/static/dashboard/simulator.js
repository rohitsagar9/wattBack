/* Solar Digital Twin — fullscreen MapLibre + Three.js overlay simulator.
   MapLibre provides the geographic base (satellite/dark/street raster);
   a transparent Three.js canvas is geo-synced on top every frame.
   Solar position is NOAA (client-side, IST); weather init is optional
   Open-Meteo. World frame: x=east, y=up, z=south, metres relative to
   the site anchor. Demonstration geometry (house/obstacles) is
   illustrative, not surveyed. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const DEG = Math.PI / 180;
const IST = 5.5;
const $ = (id) => document.getElementById(id);
const CFG = JSON.parse(document.getElementById('twin_cfg').textContent || '{}');

const VIZAG = { lat: 17.70384, lng: 83.29859, name: 'Visakhapatnam (demo)' };
const PRESETS = [
  { key: 'vizag', name: 'Visakhapatnam, India', sub: '17.704°N 83.299°E · demo site', lat: VIZAG.lat, lng: VIZAG.lng },
  CFG && CFG.lat ? { key: 'site', name: `WattBack ${CFG.name || CFG.site || 'site'}`, sub: `${(+CFG.lat).toFixed(4)}° ${(+CFG.lng).toFixed(4)}°`, lat: +CFG.lat, lng: +CFG.lng } : null,
  { key: 'delhi', name: 'Delhi, India', sub: '28.614°N 77.209°E', lat: 28.6139, lng: 77.2090 },
  { key: 'mumbai', name: 'Mumbai, India', sub: '19.076°N 72.878°E', lat: 19.0760, lng: 72.8777 },
  { key: 'blr', name: 'Bengaluru, India', sub: '12.972°N 77.595°E', lat: 12.9716, lng: 77.5946 },
].filter(Boolean);

const INIT_VIEW = { center: [VIZAG.lng, VIZAG.lat], zoom: 21.8, pitch: 46, bearing: -32 };
const INTRO_VIEW = { zoom: 19.6, pitch: 60, bearing: -50 };
const VIEW_PAD = { top: 74, right: 300, bottom: 110, left: 80 };
const HOUSE_W = 22, HOUSE_D = 15;

const state = {
  anchor: { lat: VIZAG.lat, lng: VIZAG.lng },
  date: (CFG && CFG.today) || new Date().toISOString().slice(0, 10),
  timeMin: 930,
  tilt: 10,
  az: 180,
  sunPathOn: true,
  shadowsOn: true,
  obstaclesOn: true,
  rainOn: false,
  cloudsOn: false,
  cloudCover: 40,
  dust: 0.10,
  mode: null,            // 'place' | 'measure' | null
  placeType: 'tree',
  placeH: 2.5,
  obs: [],
  measurePts: [],
  layer: 'sat',
  locKey: 'vizag',
};

let map = null;
let renderer = null, scene = null, camera = null;
let sunLight = null, ambLight = null, hemiLight = null;
let houseGrp = null, panelMesh = null, panelMat = null, panelData = [];
let obsGroup = null, nbrGroup = null, arcGroup = null, sunRig = null, sunGlow = null;
let rainPts = null, cloudGroup = null, shadowCatcher = null, groundFallback = null;
let rafId = 0, lastTS = 0, disposed = false;
let _bgKey = '';
const raycaster = new THREE.Raycaster();
const _c1 = new THREE.Color(), _c2 = new THREE.Color();

/* ================= geo helpers ================= */
function ll2m(lat, lng) {
  const a = state.anchor;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(a.lat * DEG);
  return { x: (lng - a.lng) * mLng, z: (a.lat - lat) * mLat };
}
function m2ll(x, z) {
  const a = state.anchor;
  const mLat = 111320;
  const mLng = 111320 * Math.cos(a.lat * DEG);
  return { lat: a.lat - z / mLat, lng: a.lng + x / mLng };
}
function haversine(ll1, ll2) {
  const R = 6371000, p = DEG;
  const dLat = (ll2.lat - ll1.lat) * p, dLng = (ll2.lng - ll1.lng) * p;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(ll1.lat * p) * Math.cos(ll2.lat * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/* ================= NOAA solar ================= */
function solarPos(dayOfYear, hourUTC, lat, lng) {
  const g = 2 * Math.PI / 365 * (dayOfYear - 1 + (hourUTC - 12) / 24);
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
function dayOfYearOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 864e5);
}
function sunPos() {
  const doy = dayOfYearOf(state.date);
  const utcH = ((state.timeMin / 60 - IST) % 24 + 24) % 24;
  return solarPos(doy, utcH, state.anchor.lat, state.anchor.lng);
}
function sunWorld(az, el, R) {
  const a = az * DEG, e = el * DEG;
  return new THREE.Vector3(R * Math.cos(e) * Math.sin(a), R * Math.sin(e), -R * Math.cos(e) * Math.cos(a));
}
function sunriseSunset() {
  const doy = dayOfYearOf(state.date);
  let sr = null, ss = null, prevEl = solarPos(doy, 0, state.anchor.lat, state.anchor.lng).el;
  for (let h = 0.25; h <= 24; h += 0.25) {
    const el = solarPos(doy, h % 24, state.anchor.lat, state.anchor.lng).el;
    if (prevEl < 0 && el >= 0) sr = h % 24;
    if (prevEl >= 0 && el < 0) ss = h % 24;
    prevEl = el;
  }
  return { sunrise: sr, sunset: ss };
}

/* ================= map ================= */
const MAP_STYLE = {
  version: 8,
  sources: {
    sat: {
      type: 'raster',
      tiles: ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
      tileSize: 256, attribution: 'Imagery © Google', maxzoom: 21,
    },
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, attribution: 'Esri, Maxar, Earthstar', maxzoom: 19,
    },
    dark: {
      type: 'raster',
      tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
      tileSize: 256, attribution: '© CARTO, OSM',
    },
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256, attribution: '© OpenStreetMap',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#7EB6E8' } },
    { id: 'sat', type: 'raster', source: 'sat' },
    { id: 'esri', type: 'raster', source: 'esri', layout: { visibility: 'none' } },
    { id: 'dark', type: 'raster', source: 'dark', layout: { visibility: 'none' } },
    { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
  ],
};
const LAYER_ATTRIB = {
  sat: 'Imagery © Google',
  esri: 'Imagery © Esri, Maxar',
  dark: '© CARTO, OSM',
  osm: '© OpenStreetMap',
};

function initMap() {
  if (typeof maplibregl === 'undefined') return false;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: MAP_STYLE,
      center: INIT_VIEW.center,
      zoom: INTRO_VIEW.zoom,
      pitch: INTRO_VIEW.pitch,
      bearing: INTRO_VIEW.bearing,
      maxPitch: 70,
      minZoom: 2,
      maxZoom: 22,
      padding: VIEW_PAD,
      attributionControl: false,
      dragRotate: true,
      pitchWithRotate: true,
      touchZoomRotate: true,
    });
  } catch (e) {
    return false;
  }
  map.on('error', () => {});   // tile hiccups are non-fatal
  map.on('move', () => { if (state.measurePts.length) drawMeasure(); });
  const b = 0.04;
  map.setMaxBounds([
    [state.anchor.lng - b, state.anchor.lat - b],
    [state.anchor.lng + b, state.anchor.lat + b],
  ]);
  map.on('load', () => { onMapReady(); });
  map.on('click', onMapClick);
  return true;
}

function onMapReady() {
  $('loading').classList.add('hide');
  applyScene();
  startIntro();
}

function startIntro() {
  if (!map) return;
  const final = {
    center: [state.anchor.lng, state.anchor.lat],
    zoom: INIT_VIEW.zoom, pitch: INIT_VIEW.pitch, bearing: INIT_VIEW.bearing,
    padding: VIEW_PAD,
  };
  if (navigator.webdriver) { map.jumpTo(final); return; }   // automated capture: skip cinematic
  map.easeTo({
    ...final,
    duration: 2800, easing: (t) => 1 - Math.pow(1 - t, 3),
  });
}

function setBaseLayer(id) {
  state.layer = id;
  ['sat', 'esri', 'dark', 'osm'].forEach((L) => {
    if (map.getLayer(L)) map.setLayoutProperty(L, 'visibility', L === id ? 'visible' : 'none');
  });
  const attrib = $('attrib');
  if (attrib) attrib.textContent = LAYER_ATTRIB[id] || '';
}

function flyToLoc(p) {
  state.locKey = p.key;
  state.anchor = { lat: p.lat, lng: p.lng };
  map.setMaxBounds([
    [p.lng - 0.04, p.lat - 0.04],
    [p.lng + 0.04, p.lat + 0.04],
  ]);
  map.flyTo({
    center: [p.lng, p.lat],
    zoom: INIT_VIEW.zoom, pitch: INIT_VIEW.pitch, bearing: INIT_VIEW.bearing,
    duration: 3200, padding: VIEW_PAD, essential: true,
  });
  $('loc_name').textContent = p.name;
  $('coord_meta').textContent = `${p.lat.toFixed(4)}° ${p.lng.toFixed(4)}°`;
  document.querySelectorAll('.loc-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.key === p.key);
  });
  seedDemoObs();
  rebuildScene();
  buildSunArc();
  applyScene();
  void fetchWeather();
}

/* ================= three.js overlay ================= */
function initThree() {
  const host = $('three_canvas_host');
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    $('scene_fallback').hidden = false;
    $('scene_fallback').textContent = 'WebGL unavailable — map controls still work';
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(host.clientWidth || 800, host.clientHeight || 600);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  camera = new THREE.PerspectiveCamera(36.87, (host.clientWidth || 800) / (host.clientHeight || 600), 0.5, 900);

  hemiLight = new THREE.HemisphereLight('#BFD6FF', '#4A4335', 0.55);
  scene.add(hemiLight);
  ambLight = new THREE.AmbientLight('#FFFFFF', 0.28);
  scene.add(ambLight);
  sunLight = new THREE.DirectionalLight('#FFF3D6', 1.3);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0002;
  sunLight.shadow.normalBias = 0.12;   // ≥1.5 shadow texels — kills grazing-sun acne
  const sc = sunLight.shadow.camera;
  sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70;
  sc.near = 1; sc.far = 320;
  scene.add(sunLight);
  scene.add(sunLight.target);

  obsGroup = new THREE.Group();
  scene.add(obsGroup);
  nbrGroup = new THREE.Group();
  scene.add(nbrGroup);
  arcGroup = new THREE.Group();
  scene.add(arcGroup);
  cloudGroup = new THREE.Group();
  scene.add(cloudGroup);

  // shadow catcher over the map imagery
  const catcherGeo = new THREE.PlaneGeometry(300, 300);
  catcherGeo.rotateX(-Math.PI / 2);
  shadowCatcher = new THREE.Mesh(catcherGeo,
    new THREE.ShadowMaterial({ opacity: 0.42 }));
  shadowCatcher.receiveShadow = true;
  shadowCatcher.position.y = 0.015;
  scene.add(shadowCatcher);

  makeSunRig();
  makeRain();
  makeClouds();

  window.addEventListener('resize', onResize);
  lastTS = 0;
  rafId = requestAnimationFrame(raf);
  return true;
}

function onResize() {
  if (!renderer || !camera) return;
  const host = $('three_canvas_host');
  const w = host.clientWidth || 800, h = host.clientHeight || 600;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* Map camera → Three camera, every frame (geo-alignment core). */
function syncCamera() {
  if (!map || !camera) return;
  const center = map.getCenter();
  const c = ll2m(center.lat, center.lng);
  const zoom = map.getZoom();
  const mPerPx = 40075016.6856 * Math.cos(center.lat * DEG) / (256 * Math.pow(2, zoom));
  const hPx = (renderer && renderer.domElement.clientHeight) || 600;
  const dPx = (map.transform && map.transform.cameraToCenterDistance) ||
    (hPx / 2) / Math.tan(36.87 * DEG / 2);
  const dM = dPx * mPerPx;   // pixels → metres at centre latitude
  const pitch = map.getPitch() * DEG;
  const bear = map.getBearing() * DEG;
  const g = dM * Math.cos(pitch);
  const h = Math.max(2, dM * Math.sin(pitch));
  camera.position.set(c.x - Math.sin(bear) * g, h, c.z + Math.cos(bear) * g);
  // viewport padding shifts where MapLibre draws the center on screen —
  // mirror that shift so the 3D overlay stays glued to the imagery
  const cw = renderer.domElement.clientWidth || 800;
  const chh = renderer.domElement.clientHeight || 600;
  const p = map.project([center.lng, center.lat]);
  camera.setViewOffset(cw, chh, cw / 2 - p.x, chh / 2 - p.y, cw, chh);
  camera.lookAt(c.x, 0, c.z);
}

function raf(ts) {
  if (disposed) return;
  rafId = requestAnimationFrame(raf);
  const dt = Math.min(0.05, ((ts || 0) - (lastTS || ts || 0)) / 1000);
  lastTS = ts || 0;
  syncCamera();
  animateExtras(dt, (ts || 0) / 1000);
  if (renderer && scene && camera) renderer.render(scene, camera);
}

function animateExtras(dt, t) {
  if (rainPts && rainPts.visible) {
    const p = rainPts.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - 26 * dt;
      if (y < 0) y = 26 + Math.random() * 6;
      p.setY(i, y);
    }
    p.needsUpdate = true;
    state.dust = Math.max(0, state.dust - dt * 0.06);
  }
  if (cloudGroup) {
    cloudGroup.children.forEach((cl) => {
      cl.position.x += cl.userData.speed * dt;
      if (cl.position.x > 90) cl.position.x = -90;
    });
  }
  if (sunGlow) {
    const s = 11 + Math.sin(t * 1.6) * 1.1;
    sunGlow.scale.set(s, s, 1);
  }
}

/* ================= sun rig / weather fx ================= */
function softDiscTexture(inner, outer) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

function makeSunRig() {
  sunRig = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.SphereGeometry(2.1, 20, 20),
    new THREE.MeshBasicMaterial({ color: '#FFE27A' }));
  sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture('rgba(255,214,100,.75)', 'rgba(255,180,60,0)'),
    transparent: true, depthWrite: false }));
  sunGlow.scale.set(11, 11, 1);
  sunRig.add(disc); sunRig.add(sunGlow);
  sunRig.visible = false;
  scene.add(sunRig);
}

function makeRain() {
  const N = 700;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 90;
    pos[i * 3 + 1] = Math.random() * 28;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 90;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainPts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: '#9CC8F0', size: 0.16, transparent: true, opacity: 0.75 }));
  rainPts.visible = false;
  scene.add(rainPts);
}

function makeClouds() {
  const tex = softDiscTexture('rgba(235,240,248,.92)', 'rgba(235,240,248,0)');
  for (let i = 0; i < 9; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, opacity: 0, depthWrite: false }));
    sp.position.set((Math.random() - 0.5) * 240, 115 + Math.random() * 55, (Math.random() - 0.5) * 240);
    sp.scale.set(40 + Math.random() * 45, 16 + Math.random() * 12, 1);
    sp.userData.speed = 0.5 + Math.random() * 0.8;
    cloudGroup.add(sp);
  }
}

/* ================= house + panels ================= */
function inkEdges(mesh, color, opacity) {
  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, 25),
    new THREE.LineBasicMaterial({ color: color || '#0A0F18', transparent: true,
      opacity: opacity == null ? 0.55 : opacity }));
  mesh.add(line);
  return line;
}

function panelTex() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 224;
  const x = cv.getContext('2d');
  const g = x.createLinearGradient(0, 0, 128, 224);
  g.addColorStop(0, '#0D3B8F');
  g.addColorStop(0.5, '#0A2E70');
  g.addColorStop(1, '#0D3B8F');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 224);
  x.strokeStyle = 'rgba(170,205,255,.65)';
  x.lineWidth = 2.2;
  const cols = 6, rows = 10;
  for (let i = 1; i < cols; i++) {
    x.beginPath(); x.moveTo(i * 128 / cols, 4); x.lineTo(i * 128 / cols, 220); x.stroke();
  }
  for (let j = 1; j < rows; j++) {
    x.beginPath(); x.moveTo(4, j * 224 / rows); x.lineTo(124, j * 224 / rows); x.stroke();
  }
  x.strokeStyle = '#D5E2F5';
  x.lineWidth = 5;
  x.strokeRect(2.5, 2.5, 123, 219);
  return new THREE.CanvasTexture(cv);
}

function contactTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(64, 64, 8, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,.5)');
  g.addColorStop(0.6, 'rgba(0,0,0,.22)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
}

function clearGroup(grp) {
  if (!grp) return;
  while (grp.children.length) {
    const c = grp.children.pop();
    c.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material && n.material.dispose) n.material.dispose();
    });
    if (c.geometry) c.geometry.dispose();
    if (c.material && c.material.dispose) c.material.dispose();
  }
}

function disposeHouse() {
  if (!houseGrp) return;
  scene.remove(houseGrp);
  houseGrp.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    if (n.material && n.material !== panelMat && n.material.dispose) n.material.dispose();
  });
  houseGrp = null;
  panelMesh = null;
  panelData = [];
}

function buildHouse() {
  disposeHouse();
  const tilt = state.tilt * DEG;
  const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
  const W = HOUSE_W, D = HOUSE_D;
  const wallH = 3.4;
  const roofY = wallH + 0.18;                // top of roof slab
  const u = new THREE.Vector3(1, 0, 0);
  const quat = new THREE.Quaternion().setFromAxisAngle(u, tilt);

  houseGrp = new THREE.Group();
  houseGrp.rotation.y = (180 - state.az) * DEG;
  scene.add(houseGrp);

  // soft contact shadow so the house sits on the ground
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(Math.hypot(W, D) * 0.62, 36),
    new THREE.MeshBasicMaterial({ map: contactTex(), transparent: true,
      depthWrite: false, opacity: 0.85 }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.03;
  houseGrp.add(blob);

  // plinth
  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(W + 1.1, 0.5, D + 1.1),
    new THREE.MeshStandardMaterial({ color: '#8F8270', roughness: 0.95 }));
  plinth.position.y = 0.25;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  houseGrp.add(plinth);

  // walls
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.5, wallH, D + 0.5),
    new THREE.MeshStandardMaterial({ color: '#E6DAC2', roughness: 0.88 }));
  walls.position.y = wallH / 2;
  walls.castShadow = true;
  walls.receiveShadow = true;
  inkEdges(walls, '#3A3226', 0.35);
  houseGrp.add(walls);

  // flat concrete roof slab
  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.9, 0.18, D + 0.9),
    new THREE.MeshStandardMaterial({ color: '#B5A88E', roughness: 0.92 }));
  slab.position.y = wallH + 0.09;
  slab.castShadow = true;
  slab.receiveShadow = true;
  houseGrp.add(slab);

  // parapet
  const paraMat = new THREE.MeshStandardMaterial({ color: '#D9CDB5', roughness: 0.9 });
  const paraH = 0.85, paraT = 0.16;
  [
    [W + 0.9, paraH, paraT, 0, roofY + paraH / 2, (D + 0.9) / 2 - paraT / 2],
    [W + 0.9, paraH, paraT, 0, roofY + paraH / 2, -(D + 0.9) / 2 + paraT / 2],
    [paraT, paraH, D + 0.9 - paraT * 2, (W + 0.9) / 2 - paraT / 2, roofY + paraH / 2, 0],
    [paraT, paraH, D + 0.9 - paraT * 2, -(W + 0.9) / 2 + paraT / 2, roofY + paraH / 2, 0],
  ].forEach(([sx, sy, sz, px, py, pz]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), paraMat);
    m.position.set(px, py, pz);
    m.castShadow = true;
    m.receiveShadow = true;
    houseGrp.add(m);
  });

  // stair headroom (mumty)
  const mumty = new THREE.Mesh(
    new THREE.BoxGeometry(2.8, 2.5, 2.6),
    new THREE.MeshStandardMaterial({ color: '#DED2BA', roughness: 0.9 }));
  mumty.position.set(-W / 2 + 2.0, roofY + 1.25, -D / 2 + 1.8);
  mumty.castShadow = true;
  inkEdges(mumty, '#3A3226', 0.4);
  houseGrp.add(mumty);
  const mDoor = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 1.7, 0.08),
    new THREE.MeshLambertMaterial({ color: '#4A3826' }));
  mDoor.position.set(-W / 2 + 2.0, roofY + 0.85, -D / 2 + 1.8 + 1.32);
  houseGrp.add(mDoor);

  // rooftop water tank on a raised platform
  const plat = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 0.45, 1.8),
    new THREE.MeshStandardMaterial({ color: '#9A8E7A', roughness: 0.92 }));
  plat.position.set(W / 2 - 1.8, roofY + 0.225, -D / 2 + 1.9);
  plat.castShadow = true;
  houseGrp.add(plat);
  const tank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.72, 1.35, 18),
    new THREE.MeshStandardMaterial({ color: '#17171E', roughness: 0.45 }));
  tank.position.set(W / 2 - 1.8, roofY + 0.45 + 0.675, -D / 2 + 1.9);
  tank.castShadow = true;
  inkEdges(tank, '#8A93A6', 0.4);
  houseGrp.add(tank);

  // front door + windows
  const door = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 2.1, 0.1),
    new THREE.MeshLambertMaterial({ color: '#5A4330' }));
  door.position.set(-W * 0.22, 1.05, (D + 0.5) / 2 + 0.02);
  inkEdges(door, '#3A3226', 0.5);
  houseGrp.add(door);
  const winMat = new THREE.MeshLambertMaterial({ color: '#243652' });
  [W * 0.1, W * 0.3].forEach((x) => {
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.0, 0.08), winMat);
    win.position.set(x, 1.7, (D + 0.5) / 2 + 0.02);
    inkEdges(win, '#3A3226', 0.55);
    houseGrp.add(win);
  });

  // ---- panels on tilted mount rails above the flat roof ----
  const PW = 1.0, PL = 1.7, GAPX = 0.12;
  const cols = 12, rowsN = 4;
  const stepZ = PL * cosT + 0.55;
  const rowLen = cols * (PW + GAPX) - GAPX;
  const railH = 0.30;                       // low-edge height above roof
  const n = cols * rowsN;
  const geo = new THREE.BoxGeometry(PW - 0.04, 0.045, PL - 0.04);
  panelMat = new THREE.MeshPhysicalMaterial({
    color: '#FFFFFF', roughness: 0.14, metalness: 0.5,
    clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: 0.7,
    map: panelTex() });
  panelMesh = new THREE.InstancedMesh(geo, panelMat, n);
  panelMesh.castShadow = true;
  panelMesh.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const railMat = new THREE.MeshStandardMaterial({ color: '#9AA3B0', roughness: 0.35, metalness: 0.75 });
  const postMat = railMat;
  for (let row = 0; row < rowsN; row++) {
    const b = (row - (rowsN - 1) / 2) * stepZ + 0.6;   // shift rows back (leave front roof walkway)
    const yLow = roofY + railH;
    const yHigh = yLow + PL * sinT;
    const zLow = b + (PL / 2) * cosT;
    const zHigh = b - (PL / 2) * cosT;
    // rails
    const frontRail = new THREE.Mesh(new THREE.BoxGeometry(rowLen + 0.2, 0.07, 0.07), railMat);
    frontRail.position.set(0, yLow, zLow);
    frontRail.castShadow = true;
    houseGrp.add(frontRail);
    const backRail = new THREE.Mesh(new THREE.BoxGeometry(rowLen + 0.2, 0.07, 0.07), railMat);
    backRail.position.set(0, yHigh, zHigh);
    backRail.castShadow = true;
    houseGrp.add(backRail);
    // posts
    [-rowLen / 2 + 0.25, -rowLen / 6, rowLen / 6, rowLen / 2 - 0.25].forEach((px) => {
      const fh = yLow - roofY;
      const fp = new THREE.Mesh(new THREE.BoxGeometry(0.07, fh, 0.07), postMat);
      fp.position.set(px, roofY + fh / 2, zLow);
      fp.castShadow = true;
      houseGrp.add(fp);
      const bh = yHigh - roofY;
      const bp = new THREE.Mesh(new THREE.BoxGeometry(0.07, bh, 0.07), postMat);
      bp.position.set(px, roofY + bh / 2, zHigh);
      bp.castShadow = true;
      houseGrp.add(bp);
    });
    // panels for this row
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const a = (col - (cols - 1) / 2) * (PW + GAPX);
      pos.set(a, (yLow + yHigh) / 2 + 0.04, b);
      m4.compose(pos, quat, one);
      panelMesh.setMatrixAt(i, m4);
      panelMesh.setColorAt(i, new THREE.Color('#1565C0'));
      const world = pos.clone().applyQuaternion(houseGrp.quaternion);
      panelData.push({ pos: world, shaded: false });
    }
  }
  panelMesh.instanceMatrix.needsUpdate = true;
  if (panelMesh.instanceColor) panelMesh.instanceColor.needsUpdate = true;
  houseGrp.add(panelMesh);
}

/* Procedural neighborhood context (OSM has no footprints here).
   Offsets hand-tuned to match the residential cluster in the imagery. */
function buildNeighbors() {
  if (!nbrGroup) return;
  clearGroup(nbrGroup);
  const walls = ['#E8DCC4', '#D9C9AC', '#F0E8D8', '#CBB896', '#E2D2B8', '#DCCBA8', '#EADFC8'];
  const slabs = ['#B5A88E', '#A89880', '#C0B39A', '#9C8F78'];
  // [dx, dz, w, d, h, wallIdx, hasTank]
  const defs = [
    [-5, -22, 12, 9, 6.5, 0, true],
    [17, -18, 10, 8, 5.5, 1, false],
    [26, 2, 9, 11, 7.0, 2, true],
    [20, 20, 11, 9, 5.0, 3, false],
    [-3, 27, 13, 10, 6.0, 4, true],
    [-23, 18, 9, 9, 4.5, 5, false],
    [-27, -5, 10, 12, 6.8, 6, true],
  ];
  defs.forEach(([dx, dz, w, d, h, wi, hasTank], i) => {
    const g = new THREE.Group();
    const bld = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color: walls[wi], roughness: 0.9 }));
    bld.position.y = h / 2;
    bld.castShadow = true;
    bld.receiveShadow = true;
    inkEdges(bld, '#3A3226', 0.3);
    g.add(bld);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.4, 0.16, d + 0.4),
      new THREE.MeshStandardMaterial({ color: slabs[i % slabs.length], roughness: 0.93 }));
    roof.position.y = h + 0.08;
    roof.castShadow = true;
    roof.receiveShadow = true;
    g.add(roof);
    if (hasTank) {
      const plat = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.35, 1.5),
        new THREE.MeshStandardMaterial({ color: '#9A8E7A', roughness: 0.92 }));
      plat.position.set(w / 2 - 1.4, h + 0.16 + 0.175, -d / 2 + 1.5);
      plat.castShadow = true;
      g.add(plat);
      const tank = new THREE.Mesh(
        new THREE.CylinderGeometry(0.6, 0.6, 1.15, 14),
        new THREE.MeshStandardMaterial({ color: '#1B1B24', roughness: 0.45 }));
      tank.position.set(w / 2 - 1.4, h + 0.16 + 0.35 + 0.575, -d / 2 + 1.5);
      tank.castShadow = true;
      g.add(tank);
    }
    g.position.set(dx, 0, dz);
    g.rotation.y = ((i * 37) % 11 - 5) * 0.018;
    nbrGroup.add(g);
  });
}

/* ================= obstacles ================= */
function buildObstacleMesh(o) {
  const p = ll2m(o.lat, o.lng);
  const h = Math.max(0.4, o.h || 2);
  const grp = new THREE.Group();
  if (o.type === 'tree') {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.18, h * 0.42, 8),
      new THREE.MeshLambertMaterial({ color: '#5A3B22' }));
    trunk.position.y = h * 0.21;
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(0.7, h * 0.3), 12, 10),
      new THREE.MeshLambertMaterial({ color: '#2E6B33' }));
    canopy.position.y = h * 0.42 + h * 0.24;
    grp.add(trunk); grp.add(canopy);
  } else if (o.type === 'wall') {
    const len = Math.max(1.5, h * 1.4);
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(len, h, 0.3),
      new THREE.MeshLambertMaterial({ color: '#9AA0AC' }));
    wall.position.y = h / 2;
    grp.add(wall);
    inkEdges(wall, '#3A4252', 0.6);
  } else { // tank
    const legs = new THREE.Mesh(
      new THREE.BoxGeometry(0.85, h * 0.5, 0.85),
      new THREE.MeshLambertMaterial({ color: '#5A6270' }));
    legs.position.y = h * 0.25;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.62, h * 0.62, 14),
      new THREE.MeshLambertMaterial({ color: '#20304A' }));
    body.position.y = h * 0.5 + h * 0.31;
    grp.add(legs); grp.add(body);
    inkEdges(body, '#8A93A6', 0.5);
  }
  grp.position.set(p.x, 0, p.z);
  grp.traverse((c) => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
  grp.userData.obs = o;
  return grp;
}

function rebuildObstacles() {
  clearGroup(obsGroup);
  state.obs.forEach((o) => obsGroup.add(buildObstacleMesh(o)));
  obsGroup.visible = state.obstaclesOn;
  renderObsChips();
}

function renderObsChips() {
  const box = $('obs_chips');
  if (!box) return;
  box.innerHTML = '';
  state.obs.forEach((o, i) => {
    const chip = document.createElement('span');
    chip.className = 'obs-chip';
    chip.textContent = `${o.type} ${o.h.toFixed(1)}m`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = 'remove';
    btn.onclick = () => { state.obs.splice(i, 1); rebuildObstacles(); applyScene(); };
    chip.appendChild(btn);
    box.appendChild(chip);
  });
  if (!state.obs.length) {
    const hint = document.createElement('span');
    hint.className = 'pop-hint';
    hint.style.marginTop = '0';
    hint.textContent = 'No obstacles yet.';
    box.appendChild(hint);
  }
}

function defaultObsFor(type, h) {
  if (type === 'tree') return 6;
  if (type === 'wall') return 2.5;
  return 2.3;
}

function seedDemoObs() {
  const a = state.anchor;
  const mLng = 111320 * Math.cos(a.lat * DEG);
  const mk = (dx, dz, type, h) => ({
    lat: a.lat - dz / 111320, lng: a.lng + dx / mLng, type, h,
  });
  state.obs = [
    mk(14, 11, 'tree', 7.5),
    mk(-13, 14, 'tree', 6.0),
    mk(19, -7, 'tree', 8.0),
    mk(-16, -11, 'tree', 5.5),
    mk(8, 21, 'tree', 6.5),
    mk(-10, 24, 'tree', 7.0),
    mk(25, 12, 'tree', 6.2),
    mk(-22, 5, 'wall', 2.4),
  ];
}

/* ================= sun path arc ================= */
function clearArcs() {
  if (!arcGroup) return;
  while (arcGroup.children.length) {
    const c = arcGroup.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
}

function buildSunArc() {
  clearArcs();
  if (!arcGroup) return;
  const doy = dayOfYearOf(state.date);
  const R = 48;
  const pts = [];
  for (let h = 0; h <= 24; h += 0.2) {
    const sp = solarPos(doy, h, state.anchor.lat, state.anchor.lng);
    if (sp.el > -0.5) pts.push(sunWorld(sp.az, Math.max(sp.el, 0), R));
  }
  if (pts.length > 1) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({
      color: '#FFC83D', dashSize: 1.0, gapSize: 0.8,
      transparent: true, opacity: 0.65 });
    const line = new THREE.Line(geo, mat);
    line.computeLineDistances();
    arcGroup.add(line);
  }
  const ss = sunriseSunset();
  const mkMark = (hr, color) => {
    if (hr == null) return;
    const sp = solarPos(doy, hr, state.anchor.lat, state.anchor.lng);
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 10),
      new THREE.MeshBasicMaterial({ color }));
    m.position.copy(sunWorld(sp.az, 0.4, R));
    arcGroup.add(m);
  };
  mkMark(ss.sunrise, '#FFB347');
  mkMark(ss.sunset, '#FF7A45');
  arcGroup.visible = state.sunPathOn;
}

/* ================= shading ================= */
function refreshShading(az, el) {
  if (!panelData.length) return;
  const dir = sunWorld(az, el, 1).normalize();
  const targets = [];
  if (obsGroup) obsGroup.children.forEach((c) => targets.push(c));
  if (nbrGroup) nbrGroup.children.forEach((c) => targets.push(c));
  if (houseGrp) targets.push(houseGrp);
  for (let i = 0; i < panelData.length; i++) {
    let shaded = el <= 1;
    if (!shaded) {
      raycaster.set(panelData[i].pos, dir);
      raycaster.far = 160;
      shaded = raycaster.intersectObjects(targets, true).length > 0;
    }
    panelData[i].shaded = shaded;
  }
}

function clearShaded() {
  panelData.forEach((p) => { p.shaded = false; });
}

/* ================= apply state to scene ================= */
function applyScene() {
  if (!scene || !map) return;
  const { az, el } = sunPos();
  const night = el <= 0;
  const cloud = state.cloudsOn ? state.cloudCover / 100 : 0;

  // sun light
  if (!night && state.shadowsOn) {
    sunLight.position.copy(sunWorld(az, el, 130));
    sunLight.target.position.set(0, 0, 0);
    sunLight.intensity = Math.max(0.05, Math.sin(Math.max(el, 0) * DEG)) * 1.4 * (1 - cloud * 0.8);
    sunLight.color.copy(_c1.set('#FF9A3D')).lerp(_c2.set('#FFF6E5'), Math.min(1, el / 35));
    sunLight.castShadow = true;
  } else {
    sunLight.intensity = 0;
    sunLight.castShadow = false;
  }
  ambLight.intensity = night ? 0.16 : (cloud > 0.4 ? 0.45 : 0.26);
  hemiLight.intensity = night ? 0.22 : (cloud > 0.4 ? 0.9 : 0.55);

  if (sunRig) {
    sunRig.visible = !night;
    if (!night) sunRig.position.copy(sunWorld(az, el, 78));
  }

  // map background = sky
  let bg;
  if (night) bg = '#0A1220';
  else if (el < 8) bg = mixHex('#5A4070', cloud > 0.4 ? '#8A93A3' : '#7EB6E8', el / 8);
  else bg = cloud > 0.4 ? mixHex('#8A93A3', '#6E7787', cloud) : '#7EB6E8';
  if (bg !== _bgKey) {
    _bgKey = bg;
    try { map.setPaintProperty('bg', 'background-color', bg); } catch (e) { /* style not ready */ }
  }

  // panels
  if (state.shadowsOn && !night) refreshShading(az, el);
  else clearShaded();
  if (panelMesh && panelMesh.instanceColor) {
    const dusty = _c1.set('#1E6DD8').lerp(_c2.set('#4A4636'), Math.min(1, state.dust / 0.22) * 0.55);
    const shadedC = new THREE.Color('#E5484D');
    const nightC = new THREE.Color('#0F1E38');
    for (let i = 0; i < panelData.length; i++) {
      const c = new THREE.Color();
      if (night) c.copy(nightC);
      else if (panelData[i].shaded) c.copy(shadedC);
      else c.copy(dusty);
      panelMesh.setColorAt(i, c);
    }
    panelMesh.instanceColor.needsUpdate = true;
  }

  if (arcGroup) arcGroup.visible = state.sunPathOn;
  if (obsGroup) obsGroup.visible = state.obstaclesOn;
  if (rainPts) rainPts.visible = state.rainOn;
  if (cloudGroup) {
    // fade cloud discs out as the camera drops toward property zoom so
    // they never wash the ground view (sun-dimming still applies)
    const zf = Math.min(1, Math.max(0, (20.6 - map.getZoom()) / 1.2));
    cloudGroup.children.forEach((cl) => {
      cl.material.opacity = cloud * 0.85 * zf;
    });
  }

  // header meta
  const hh = String(Math.floor(state.timeMin / 60)).padStart(2, '0');
  const mm = String(state.timeMin % 60).padStart(2, '0');
  $('time_label').textContent = `${hh}:${mm}`;
  $('sun_meta').textContent = night
    ? 'NIGHT'
    : `SUN EL ${el.toFixed(0)}° · AZ ${az.toFixed(0)}°`;
}

function mixHex(a, b, t) {
  _c1.set(a); _c2.set(b);
  return '#' + _c1.lerp(_c2, Math.min(1, Math.max(0, t))).getHexString();
}

/* ================= rebuild ================= */
function rebuildScene() {
  if (!scene) return;
  buildHouse();
  buildNeighbors();
  rebuildObstacles();
  applyScene();
}

/* ================= interaction ================= */
function onMapClick(e) {
  if (state.mode === 'place') {
    const o = {
      lat: e.lngLat.lat, lng: e.lngLat.lng,
      h: state.placeH, type: state.placeType,
    };
    state.obs.push(o);
    rebuildObstacles();
    applyScene();
    return;
  }
  if (state.mode === 'measure') {
    state.measurePts.push({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    if (state.measurePts.length > 2) state.measurePts = [state.measurePts.pop()];
    drawMeasure();
  }
}

function drawMeasure() {
  const layer = $('measure_layer');
  layer.innerHTML = '';
  layer.hidden = state.measurePts.length === 0;
  state.measurePts.forEach((p, i) => {
    const pt = map.project([p.lng, p.lat]);
    const dot = document.createElement('div');
    dot.className = 'm-point';
    dot.style.left = pt.x + 'px';
    dot.style.top = pt.y + 'px';
    layer.appendChild(dot);
    if (i === 1) {
      const d = haversine(state.measurePts[0], state.measurePts[1]);
      const mid = map.project([
        (state.measurePts[0].lng + state.measurePts[1].lng) / 2,
        (state.measurePts[0].lat + state.measurePts[1].lat) / 2,
      ]);
      const lab = document.createElement('div');
      lab.className = 'm-label';
      lab.textContent = d >= 1000 ? (d / 1000).toFixed(2) + ' km' : d.toFixed(1) + ' m';
      lab.style.left = mid.x + 'px';
      lab.style.top = mid.y + 'px';
      layer.appendChild(lab);
      $('measure_out').textContent = lab.textContent;
    }
  });
}

function setMode(mode, force) {
  state.mode = force ? mode : (state.mode === mode ? null : mode);
  $('tool_measure').classList.toggle('active', state.mode === 'measure' || (!$('tool_pop').hidden && !$('pop_measure').hidden));
  const addArmed = state.mode === 'place';
  document.querySelectorAll('#add_obs_seg .seg-btn').forEach((b) => {
    b.classList.toggle('active', addArmed && b.dataset.add === state.placeType);
  });
  $('map').style.cursor = state.mode ? 'crosshair' : '';
}

/* ================= open-meteo init ================= */
async function fetchWeather() {
  const st = $('weather_status');
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${state.anchor.lat.toFixed(4)}` +
    `&longitude=${state.anchor.lng.toFixed(4)}` +
    `&daily=precipitation_sum&current=cloud_cover&past_days=4&timezone=Asia%2FKolkata`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('http ' + r.status);
    const j = await r.json();
    const daily = (j.daily && j.daily.precipitation_sum) || [];
    const past = daily.slice(0, Math.max(0, daily.length - 1));
    const rainSum = past.reduce((s, v) => s + (v || 0), 0);
    state.dust = rainSum > 5 ? 0.02 : rainSum > 1 ? 0.06 : 0.13;
    const cc = j.current && j.current.cloud_cover;
    if (typeof cc === 'number') {
      state.cloudCover = Math.round(cc);
      $('cloud_slider').value = String(state.cloudCover);
      $('cloud_val').textContent = state.cloudCover + '%';
      if (state.cloudCover > 30) {
        state.cloudsOn = true;
        $('tgl_clouds').checked = true;
        $('cloud_lab').hidden = false;
      }
    }
    const today = daily[daily.length - 1];
    if (typeof today === 'number' && today > 0.8) {
      state.rainOn = true;
      $('tgl_rain').checked = true;
    }
    st.textContent = 'weather: Open-Meteo (live) · controls stay manual';
    applyScene();
  } catch (e) {
    st.textContent = 'weather offline — manual controls active';
  }
}

/* ================= UI wiring ================= */
function showPop(id) {
  const bodies = ['pop_layers', 'pop_location', 'pop_measure', 'pop_settings'];
  $('tool_pop').hidden = false;
  bodies.forEach((b) => { $(b).hidden = b !== id; });
}

function wireUI() {
  if (window.lucide) lucide.createIcons();

  const tools = [
    ['tool_layers', 'pop_layers'],
    ['tool_location', 'pop_location'],
    ['tool_measure', 'pop_measure'],
    ['tool_settings', 'pop_settings'],
  ];
  tools.forEach(([btn, pop]) => {
    $(btn).addEventListener('click', () => {
      const already = !$('tool_pop').hidden && !$(pop).hidden;
      tools.forEach(([b]) => $(b).classList.remove('active'));
      if (state.mode === 'measure') setMode(null);
      if (already) { $('tool_pop').hidden = true; return; }
      $(btn).classList.add('active');
      showPop(pop);
      if (pop === 'pop_measure') setMode('measure', true);
    });
  });

  document.querySelectorAll('#pop_layers .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#pop_layers .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      setBaseLayer(b.dataset.layer);
    });
  });

  const locList = $('loc_list');
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loc-item' + (p.key === state.locKey ? ' active' : '');
    btn.dataset.key = p.key;
    btn.innerHTML = `${p.name}<small>${p.sub || ''}</small>`;
    btn.addEventListener('click', () => flyToLoc(p));
    locList.appendChild(btn);
  });

  $('measure_clear').addEventListener('click', () => {
    state.measurePts = [];
    $('measure_out').textContent = '—';
    drawMeasure();
  });

  // settings
  const tiltS = $('tilt_slider'), azS = $('az_slider');
  tiltS.value = String(state.tilt);
  azS.value = String(state.az);
  $('tilt_val').textContent = state.tilt + '°';
  $('az_val').textContent = azLabel(state.az);
  let rebuildTimer = 0;
  const queueRebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { buildHouse(); applyScene(); }, 120);
  };
  tiltS.addEventListener('input', () => {
    state.tilt = +tiltS.value;
    $('tilt_val').textContent = state.tilt + '°';
    queueRebuild();
  });
  azS.addEventListener('input', () => {
    state.az = +azS.value;
    $('az_val').textContent = azLabel(state.az);
    queueRebuild();
  });
  document.querySelectorAll('#add_obs_seg .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.placeType = b.dataset.add;
      state.placeH = defaultObsFor(state.placeType);
      $('obs_h_slider').value = String(state.placeH);
      $('obs_h_val').textContent = state.placeH.toFixed(1) + ' m';
      setMode('place');
      $('add_obs_hint').textContent =
        `Click the map to place a ${state.placeType} (${state.placeH.toFixed(1)} m). Click the button again to stop.`;
    });
  });
  $('obs_h_slider').addEventListener('input', () => {
    state.placeH = +$('obs_h_slider').value;
    $('obs_h_val').textContent = state.placeH.toFixed(1) + ' m';
  });

  // time / date
  const timeS = $('time_slider');
  timeS.value = String(state.timeMin);
  timeS.addEventListener('input', () => {
    state.timeMin = +timeS.value;
    applyScene();
  });
  const dateI = $('date_input');
  dateI.value = state.date;
  dateI.addEventListener('change', () => {
    if (!dateI.value) return;
    state.date = dateI.value;
    buildSunArc();
    applyScene();
  });
  document.querySelectorAll('#season_seg .seg-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#season_seg .seg-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const m = +b.dataset.month;
      const y = state.date.slice(0, 4);
      const day = (m === 6) ? '21' : (m === 12) ? '22' : '20';
      state.date = `${y}-${String(m).padStart(2, '0')}-${day}`;
      dateI.value = state.date;
      buildSunArc();
      applyScene();
    });
  });

  // toggles
  $('tgl_sunpath').addEventListener('change', (e) => {
    state.sunPathOn = e.target.checked;
    if (arcGroup) arcGroup.visible = state.sunPathOn;
  });
  $('tgl_shadows').addEventListener('change', (e) => {
    state.shadowsOn = e.target.checked;
    applyScene();
  });
  $('tgl_obstacles').addEventListener('change', (e) => {
    state.obstaclesOn = e.target.checked;
    if (obsGroup) obsGroup.visible = state.obstaclesOn;
  });
  $('tgl_rain').addEventListener('change', (e) => {
    state.rainOn = e.target.checked;
    if (rainPts) rainPts.visible = state.rainOn;
    applyScene();
  });
  $('tgl_clouds').addEventListener('change', (e) => {
    state.cloudsOn = e.target.checked;
    $('cloud_lab').hidden = !state.cloudsOn;
    applyScene();
  });
  $('cloud_slider').addEventListener('input', () => {
    state.cloudCover = +$('cloud_slider').value;
    $('cloud_val').textContent = state.cloudCover + '%';
    applyScene();
  });

  // nav cluster
  $('btn_zoom_in').addEventListener('click', () => map && map.zoomIn());
  $('btn_zoom_out').addEventListener('click', () => map && map.zoomOut());
  $('compass').addEventListener('click', () => map && map.easeTo({ bearing: 0, duration: 500 }));
  $('btn_reset').addEventListener('click', () => {
    if (!map) return;
    $('btn_2d').classList.remove('active');
    $('btn_3d').classList.add('active');
    startIntro();
  });
  $('btn_2d').addEventListener('click', () => {
    if (!map) return;
    $('btn_2d').classList.add('active');
    $('btn_3d').classList.remove('active');
    map.easeTo({ pitch: 0, duration: 700 });
  });
  $('btn_3d').addEventListener('click', () => {
    if (!map) return;
    $('btn_3d').classList.add('active');
    $('btn_2d').classList.remove('active');
    map.easeTo({ pitch: INIT_VIEW.pitch, duration: 700 });
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.mode) setMode(null);
      $('tool_pop').hidden = true;
      tools.forEach(([b]) => $(b).classList.remove('active'));
    }
  });

  // compass needle follows bearing
  const needle = $('cmp_needle');
  const spin = () => {
    if (disposed) return;
    if (map && needle) needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    requestAnimationFrame(spin);
  };
  requestAnimationFrame(spin);
}

function azLabel(az) {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(((az % 360) + 360) % 360 / 45) % 8;
  return `${Math.round(az)}° ${names[idx]}`;
}

/* ================= boot ================= */
function boot() {
  if (!window.WebGLRenderingContext) {
    $('fatal').hidden = false;
    return;
  }
  wireUI();
  seedDemoObs();
  const mapOk = initMap();
  const threeOk = initThree();
  if (threeOk) {
    rebuildScene();
    buildSunArc();
    applyScene();
  }
  if (!mapOk) {
    $('loading').classList.add('hide');
    $('scene_fallback').hidden = false;
    $('scene_fallback').textContent = 'map library unavailable — 3D demo scene only';
    if (threeOk && !groundFallback) {
      groundFallback = new THREE.Mesh(
        new THREE.PlaneGeometry(240, 240),
        new THREE.MeshStandardMaterial({ color: '#3E4A3A', roughness: 1 }));
      groundFallback.rotation.x = -Math.PI / 2;
      groundFallback.receiveShadow = true;
      scene.add(groundFallback);
    }
  }
  void fetchWeather();
  window.addEventListener('beforeunload', dispose);
}

function dispose() {
  disposed = true;
  cancelAnimationFrame(rafId);
  window.removeEventListener('beforeunload', dispose);
  if (map) { try { map.remove(); } catch (e) { /* noop */ } map = null; }
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    renderer = null;
  }
  scene = null;
  camera = null;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
