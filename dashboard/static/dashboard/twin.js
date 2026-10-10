/* WattBack Digital Twin — draw geometry on satellite tiles, replay any day
   of the year in a Three.js scene: sun arc, obstacle shadows, weather-driven
   panel state. Server (pvlib/ERA5/HSU) stays authoritative for numbers; the
   scene uses a compact NOAA solar position so scrubbing stays offline-fast.
   World convention: x = east, y = up, z = south (north = -z), metres. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const DEG = Math.PI / 180;
const CFG = JSON.parse(document.getElementById('twin_cfg').textContent);
const $ = (id) => document.getElementById(id);

const S = {
  data: null,          // API payload
  W: [],               // weather_year rows
  C: {},               // consts from API
  H: null,             // horizon {points:[{az,el}]}
  SIM: null,
  dayIdx: 0,           // index into W
  timeSlot: 48,        // 15-min slots 0..95
  poly: [],            // [{lat,lng}] array corners
  obs: [],             // [{lat,lng,h,type}]
  mode: 'idle',        // idle | array | obs
  pending: null,       // pending obstacle {lat,lng}
  playing: false,
  sweeping: false,
  playRAF: null,
  sweepTimer: null,
};

/* ---------- geo helpers ---------- */
const M_LAT = 111320;
const mPerLng = (lat0) => M_LAT * Math.cos(lat0 * DEG);
function ll2m(lat, lng) {
  const x = (lng - CFG.lng) * mPerLng(CFG.lat);
  const z = -(lat - CFG.lat) * M_LAT;
  return { x, z };
}

function presetPoly() {
  const c = [CFG.lat, CFG.lng];
  const dLat = 8 / M_LAT, dLng = 12 / mPerLng(CFG.lat);
  return [
    { lat: c[0] + dLat / 2, lng: c[1] - dLng / 2 },
    { lat: c[0] + dLat / 2, lng: c[1] + dLng / 2 },
    { lat: c[0] - dLat / 2, lng: c[1] + dLng / 2 },
    { lat: c[0] - dLat / 2, lng: c[1] - dLng / 2 },
  ];
}

/* ---------- persistence ---------- */
const LS_KEY = 'wb.twin.v1.' + CFG.site;
function saveGeom() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ poly: S.poly, obs: S.obs })); } catch (e) { /* private mode */ }
  updateStorageChip();
}
function loadGeom() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const g = JSON.parse(raw);
    S.poly = Array.isArray(g.poly) ? g.poly : [];
    S.obs = Array.isArray(g.obs) ? g.obs : [];
    return S.poly.length >= 3;
  } catch (e) { return false; }
}
function updateStorageChip() {
  const chip = $('storage_chip');
  if (!chip) return;
  if (S.poly.length >= 3) {
    chip.textContent = 'geom: drawn · ' + S.poly.length + ' corners · ' + S.obs.length + ' obstacle' + (S.obs.length === 1 ? '' : 's');
    chip.className = 'pill';
  } else {
    chip.textContent = 'geom: preset 12×8 m';
    chip.className = 'pill';
  }
}

/* ---------- map drawing (Leaflet) ---------- */
let map = null, polyLayer = null, obsLayer = null;
function initMap() {
  if (typeof L === 'undefined') {
    $('twin_map').innerHTML = '<p class="muted mono">map library unavailable; check connection</p>';
    return;
  }
  const esri = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, attribution: 'Imagery © Esri · Maxar · Earthstar Geographics' });
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
  map = L.map('twin_map', { layers: [esri] }).setView([CFG.lat, CFG.lng], 17);
  L.control.layers({ 'Satellite (Esri)': esri, 'Streets (OSM)': osm }, null, { position: 'topleft' }).addTo(map);
  polyLayer = L.layerGroup().addTo(map);
  obsLayer = L.layerGroup().addTo(map);
  map.on('click', onMapClick);
  redrawGeomLayers();
}

function onMapClick(e) {
  if (S.mode === 'array') {
    S.poly.push({ lat: e.latlng.lat, lng: e.latlng.lng });
    redrawGeomLayers();
    if (S.poly.length >= 3) {
      $('draw_help').textContent = 'array corners: ' + S.poly.length + ' — press FINISH ARRAY (or keep clicking)';
      $('btn_array').textContent = 'FINISH ARRAY';
    }
    saveGeom();
    rebuildScene();
  } else if (S.mode === 'obs') {
    S.pending = { lat: e.latlng.lat, lng: e.latlng.lng };
    $('obs_form').hidden = false;
    const p = ll2m(S.pending.lat, S.pending.lng);
    $('obs_pending').textContent = 'at ' + fmtOffset(p);
  }
}

function fmtOffset(p) {
  const ew = Math.abs(p.x) < 0.05 ? '' : Math.abs(p.x).toFixed(1) + 'm ' + (p.x > 0 ? 'E' : 'W');
  const ns = Math.abs(p.z) < 0.05 ? '' : Math.abs(p.z).toFixed(1) + 'm ' + (p.z > 0 ? 'S' : 'N');
  return (ew + ' ' + ns).trim() || 'origin';
}

function redrawGeomLayers() {
  if (!polyLayer) return;
  polyLayer.clearLayers();
  obsLayer.clearLayers();
  if (S.poly.length) {
    L.polygon(S.poly.map((p) => [p.lat, p.lng]),
      { color: '#00FF88', weight: 3, fillOpacity: 0.12 }).addTo(polyLayer);
    S.poly.forEach((p, i) => {
      L.circleMarker([p.lat, p.lng], { radius: 5, color: '#0E131F', weight: 2, fillColor: '#00FF88', fillOpacity: 1 })
        .bindTooltip('corner ' + (i + 1)).addTo(polyLayer);
    });
  }
  S.obs.forEach((o, i) => {
    L.circleMarker([o.lat, o.lng], { radius: 7, color: '#0E131F', weight: 2, fillColor: '#FF9800', fillOpacity: 1 })
      .bindTooltip(o.type + ' ' + o.h + 'm').addTo(obsLayer);
  });
  renderObsList();
}

function renderObsList() {
  const ul = $('obs_list');
  ul.innerHTML = '';
  S.obs.forEach((o, i) => {
    const p = ll2m(o.lat, o.lng);
    const li = document.createElement('li');
    li.textContent = o.type + ' ' + o.h + 'm @ ' + fmtOffset(p);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '×';
    btn.title = 'remove';
    btn.onclick = () => { S.obs.splice(i, 1); saveGeom(); redrawGeomLayers(); rebuildScene(); };
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

/* ---------- Three.js scene ---------- */
let renderer = null, scene = null, camera = null, controls = null, sunRig = null,
  sunRing = null, sunGlow = null, sunLight = null, ambLight = null, hemiLight = null,
  panelMesh = null, panelData = [], obsGroup = null, groundMesh = null, rainPts = null,
  cloudGroup = null, birdGroup = null, arcGroup = null, sceneOK = false,
  radarGrp = null, stars = null, dustMotes = null,
  houseGrp = null, panelMat = null, skyMesh = null, skyCv = null, skyTex = null,
  moonRig = null, windowMat = null, doorMat = null;
let obsTags = [], shadowMeshes = [], sunTag = null, diodeTag = null;
const raycaster = new THREE.Raycaster();
const SPAN_BASE = 70;
const _tmpC = new THREE.Color();
const _flashC = new THREE.Color();

function sceneSpan() {
  let ext = 20;
  S.poly.forEach((p) => { const m = ll2m(p.lat, p.lng); ext = Math.max(ext, Math.abs(m.x), Math.abs(m.z)); });
  S.obs.forEach((o) => { const m = ll2m(o.lat, o.lng); ext = Math.max(ext, Math.abs(m.x), Math.abs(m.z)); });
  return Math.max(60, ext * 2.6);
}

function initScene() {
  const host = $('twin_scene');
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (e) {
    host.innerHTML = '<p class="mono" style="padding:20px;color:#9AA9C4">WebGL unavailable — map + diagnostics below still work</p>';
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth || 640, host.clientHeight || 460);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.insertBefore(renderer.domElement, host.firstChild);

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#0E131F');
  scene.fog = new THREE.Fog('#0E131F', 90, 280);

  camera = new THREE.PerspectiveCamera(48, (host.clientWidth || 640) / (host.clientHeight || 460), 0.1, 600);
  camera.position.set(72, 58, 82);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.enableDamping = true;
  controls.maxDistance = 160;
  controls.minDistance = 6;
  controls.maxPolarAngle = 1.48;
  controls.enabled = false;                       // enabled after fly-in
  S.intro = { t: 0, from: camera.position.clone(), to: new THREE.Vector3(28, 22, 30) };

  hemiLight = new THREE.HemisphereLight('#8FB7FF', '#3A3428', 0.55);
  scene.add(hemiLight);
  ambLight = new THREE.AmbientLight('#FFFFFF', 0.25);
  scene.add(ambLight);
  sunLight = new THREE.DirectionalLight('#FFF3D6', 1.1);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const sc = sunLight.shadow.camera;
  sc.left = -SPAN_BASE; sc.right = SPAN_BASE; sc.top = SPAN_BASE; sc.bottom = -SPAN_BASE;
  sc.near = 1; sc.far = 260;
  scene.add(sunLight);
  scene.add(sunLight.target);

  buildSunRig();

  obsGroup = new THREE.Group();
  scene.add(obsGroup);
  arcGroup = new THREE.Group();
  scene.add(arcGroup);
  cloudGroup = new THREE.Group();
  scene.add(cloudGroup);
  birdGroup = new THREE.Group();
  scene.add(birdGroup);

  sunTag = document.createElement('div');
  sunTag.className = 'scene-tag';
  const ov = $('scene_overlay');
  if (ov) ov.appendChild(sunTag);

  makeGround();
  makeSky();
  makeMoon();
  makeStars();
  makeDust();
  makeClouds();
  makeBirds();
  makeRain();

  window.addEventListener('resize', () => {
    const w = host.clientWidth || 640, h = host.clientHeight || 460;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  sceneOK = true;
  animate();
  return true;
}

function makeGround() {
  const span = sceneSpan();
  const geo = new THREE.PlaneGeometry(span, span);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: '#232D42' });
  groundMesh = new THREE.Mesh(geo, mat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  const grid = new THREE.GridHelper(span, Math.round(span / 2), '#00FF88', 'rgba(0,255,136,.14)');
  grid.position.y = 0.012;
  grid.material.transparent = true;
  if (Array.isArray(grid.material)) grid.material.forEach((m) => { m.opacity = 0.2; m.transparent = true; });
  else { grid.material.opacity = 0.2; }
  scene.add(grid);
  // range rings — OSINT map language
  [10, 20, 30].forEach((r) => {
    const pts = [];
    for (let a = 0; a <= 72; a++) {
      const th = (a / 72) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(th) * r, 0.02, Math.sin(th) * r));
    }
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: '#00FF88', transparent: true, opacity: 0.12 }));
    scene.add(ring);
  });
  // radar sweep wedge
  radarGrp = new THREE.Group();
  const sweep = new THREE.Mesh(
    new THREE.PlaneGeometry(span * 0.46, 0.7),
    new THREE.MeshBasicMaterial({ color: '#00FF88', transparent: true, opacity: 0.2,
      side: THREE.DoubleSide, depthWrite: false }));
  sweep.rotation.x = -Math.PI / 2;
  sweep.position.set(span * 0.23, 0.05, 0);
  radarGrp.add(sweep);
  scene.add(radarGrp);
  loadTileTexture(span);
}

function inkEdges(mesh, color, opacity) {
  const line = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry, 25),
    new THREE.LineBasicMaterial({ color: color || '#00FF88', transparent: true,
      opacity: opacity == null ? 0.9 : opacity }));
  mesh.add(line);
  return line;
}

function buildSunRig() {
  sunRig = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 20, 20),
    new THREE.MeshBasicMaterial({ color: '#FFE57A' }));
  sunRig.add(core);
  sunRing = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.9, 0.06, 8, 48),
    new THREE.MeshBasicMaterial({ color: '#00FF88' }));
  const cross = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-2.7, 0, 0), new THREE.Vector3(2.7, 0, 0),
      new THREE.Vector3(0, -2.7, 0), new THREE.Vector3(0, 2.7, 0)]),
    new THREE.LineBasicMaterial({ color: '#00FF88' }));
  sunRing.add(ring); sunRing.add(cross);
  sunRing.rotation.x = Math.PI / 2;
  sunRig.add(sunRing);
  sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture('rgba(255,229,122,.6)', 'rgba(255,229,122,0)'),
    transparent: true, depthWrite: false }));
  sunGlow.scale.set(11, 11, 1);
  sunRig.add(sunGlow);
  sunRig.position.set(0, 52, 0);
  scene.add(sunRig);
}

const SKY_PAL = {
  night: ['#04060E', '#0A101C', '#16203A'],
  dusk: ['#2A1B4A', '#8A3E6B', '#FF9800'],
  day: ['#1E5AA8', '#4E8FD6', '#A8C8E8'],
  cloudy: ['#39404C', '#6B7280', '#9AA1AC'],
};

function makeSky() {
  skyCv = document.createElement('canvas');
  skyCv.width = 2; skyCv.height = 256;
  skyTex = new THREE.CanvasTexture(skyCv);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyMesh = new THREE.Mesh(
    new THREE.SphereGeometry(320, 24, 16),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide,
      fog: false, depthWrite: false }));
  skyMesh.renderOrder = -10;
  scene.add(skyMesh);
  paintSky('night');
}

function paintSky(key) {
  const pal = SKY_PAL[key] || SKY_PAL.night;
  const x = skyCv.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, pal[0]);
  g.addColorStop(0.55, pal[1]);
  g.addColorStop(1, pal[2]);
  x.fillStyle = g;
  x.fillRect(0, 0, 2, 256);
  skyTex.needsUpdate = true;
  if (scene.fog) scene.fog.color.set(pal[2]);
  if (scene.background && scene.background.isColor) scene.background.set(pal[2]);
}

function makeMoon() {
  moonRig = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.SphereGeometry(1.6, 18, 18),
    new THREE.MeshBasicMaterial({ color: '#D9E2F0' }));
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softDiscTexture('rgba(217,226,240,.5)', 'rgba(217,226,240,0)'),
    transparent: true, depthWrite: false }));
  glow.scale.set(9, 9, 1);
  moonRig.add(disc); moonRig.add(glow);
  moonRig.visible = false;
  scene.add(moonRig);
}

function makeStars() {
  const N = 240, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.42;
    pos[i * 3] = Math.cos(th) * Math.cos(ph) * 230;
    pos[i * 3 + 1] = Math.sin(ph) * 230 + 10;
    pos[i * 3 + 2] = Math.sin(th) * Math.cos(ph) * 230;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({
    color: '#DDE5F2', size: 1.1, transparent: true, opacity: 0, sizeAttenuation: false }));
  scene.add(stars);
}

function makeDust() {
  const N = 130, pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 70;
    pos[i * 3 + 1] = 0.4 + Math.random() * 4.5;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 70;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  dustMotes = new THREE.Points(g, new THREE.PointsMaterial({
    color: '#C9B896', size: 0.2, transparent: true, opacity: 0 }));
  scene.add(dustMotes);
}

function panelTex() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const x = cv.getContext('2d');
  x.fillStyle = '#D7DEE8';
  x.fillRect(0, 0, 64, 64);
  x.strokeStyle = '#5E6E82';
  x.lineWidth = 1;
  for (let i = 1; i < 3; i++) {
    x.beginPath(); x.moveTo(i * 21, 2); x.lineTo(i * 21, 62); x.stroke();
    x.beginPath(); x.moveTo(2, i * 16); x.lineTo(62, i * 16); x.stroke();
  }
  x.strokeStyle = '#2A3A50';
  x.lineWidth = 4;
  x.strokeRect(1, 1, 62, 62);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function projectTag(el, pos) {
  const host = $('twin_scene');
  const v = pos.clone().project(camera);
  if (v.z > 1 || Math.abs(v.x) > 1.15 || Math.abs(v.y) > 1.15) { el.classList.remove('on'); return; }
  el.style.left = ((v.x * 0.5 + 0.5) * host.clientWidth) + 'px';
  el.style.top = ((-v.y * 0.5 + 0.5) * host.clientHeight) + 'px';
  el.classList.add('on');
}

function updateTags() {
  if (sunTag && sunRig) {
    if (sunRig.visible) { sunTag.textContent = 'SUN · EL ' + (S._sunEl || 0).toFixed(0) + '° AZ ' + (S._sunAz || 0).toFixed(0) + '°'; projectTag(sunTag, sunRig.position); }
    else sunTag.classList.remove('on');
  }
  obsTags.forEach((t) => projectTag(t.el, t.pos));
  if (diodeTag && diodeTag._pos) projectTag(diodeTag, diodeTag._pos);
}

/* Esri tiles → CanvasTexture. CORS-safe path with silent grid fallback. */
function loadTileTexture(span) {
  const z = Math.max(15, Math.min(18, Math.round(Math.log2(156543.04 * Math.cos(CFG.lat * DEG) / (span / 5)))));
  const n = Math.pow(2, z);
  const latRad = CFG.lat * DEG;
  const x0 = Math.floor((CFG.lng + 180) / 360 * n);
  const y0 = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  const r = 2;
  const size = 256 * (2 * r + 1);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#5C6B4A';
  ctx.fillRect(0, 0, size, size);
  let loaded = 0, failed = 0;
  const total = (2 * r + 1) * (2 * r + 1);
  const done = () => {
    if (loaded + failed < total) return;
    if (failed > total * 0.4 || !loaded) return; // keep plain ground
    try {
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      groundMesh.material.map = tex;
      groundMesh.material.color.set('#8A97AB');   // dim cool tint — satellite, not photo
      groundMesh.material.needsUpdate = true;
    } catch (e) { /* tainted canvas — keep plain ground */ }
  };
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try { ctx.drawImage(img, (dx + r) * 256, (dy + r) * 256); loaded++; } catch (e) { failed++; }
        done();
      };
      img.onerror = () => { failed++; done(); };
      img.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' +
        z + '/' + (y0 + dy) + '/' + (x0 + dx);
    }
  }
}

/* panels + building + obstacles from drawn geometry */
function rebuildScene() {
  if (!sceneOK) return;
  [panelMesh].forEach((m) => { if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } });
  panelMesh = null;
  panelData = [];
  while (obsGroup.children.length) {
    const c = obsGroup.children.pop();
    c.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material) n.material.dispose();
    });
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
  obsTags.forEach((t) => t.el.remove());
  obsTags = [];
  shadowMeshes.forEach((m) => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); });
  shadowMeshes = [];
  if (diodeTag) { diodeTag.remove(); diodeTag = null; }
  if (houseGrp) {
    scene.remove(houseGrp);
    houseGrp.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material && n.material !== doorMat && n.material !== windowMat &&
          n.material.dispose) n.material.dispose();
    });
    houseGrp = null;
  }
  clearArcs();
  buildArray();
  buildObstacles();
  buildArcs();
  refreshShading();
}

function arrayFootprint() {
  const pts = (S.poly.length >= 3 ? S.poly : presetPoly()).map((p) => ll2m(p.lat, p.lng));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cz = pts.reduce((s, p) => s + p.z, 0) / pts.length;
  // principal axis = edge 0→1
  const ux = pts[1].x - pts[0].x, uz = pts[1].z - pts[0].z;
  const ul = Math.hypot(ux, uz) || 1;
  const u = { x: ux / ul, z: uz / ul };
  const halfW = Math.max(...pts.map((p) => Math.abs((p.x - cx) * u.x + (p.z - cz) * u.z)));
  const v = { x: -u.z, z: u.x };
  const halfD = Math.max(...pts.map((p) => Math.abs((p.x - cx) * v.x + (p.z - cz) * v.z)));
  return { c: { x: cx, z: cz }, u, halfW: halfW * 2, halfD: halfD * 2 };
}

function buildArray() {
  const fp = arrayFootprint();
  const tilt = (CFG.tilt || 25) * DEG;
  const W = Math.max(3, fp.halfW);            // ridge-to-ridge width
  const D = Math.max(3, fp.halfD);            // front-to-back depth
  const u = { x: fp.u.x, z: fp.u.z };         // ridge axis (polygon edge)
  const v = { x: -u.z, z: u.x };
  const azR = (CFG.az || 180) * DEG;
  const siteFace = { x: Math.sin(azR), z: -Math.cos(azR) };
  const face = (v.x * siteFace.x + v.z * siteFace.z) >= 0 ? v : { x: -v.x, z: -v.z };
  const u3 = new THREE.Vector3(u.x, 0, u.z).normalize();
  const yaw = Math.atan2(face.x, face.z);
  const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const qTilt = new THREE.Quaternion().setFromAxisAngle(u3, tilt);
  const quat = qTilt.clone().multiply(qYaw);
  const sinT = Math.sin(tilt), cosT = Math.cos(tilt);
  const wallH = Math.min(5.2, 2.25 + (D / 2) * sinT);
  const slopeLen = D / cosT + 0.45;
  const c = fp.c;

  if (!houseGrp) { houseGrp = new THREE.Group(); scene.add(houseGrp); }
  houseGrp.position.set(c.x, 0, c.z);
  houseGrp.scale.setScalar(1);

  // ---- walls + gabled skillion roof ----
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(W + 0.5, wallH, D + 0.5),
    new THREE.MeshLambertMaterial({ color: '#E8E2D4' }));
  walls.position.y = wallH / 2;
  walls.castShadow = true;
  walls.receiveShadow = true;
  inkEdges(walls, '#0E131F', 0.5);
  houseGrp.add(walls);

  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(W + 1.0, 0.15, slopeLen),
    new THREE.MeshLambertMaterial({ color: '#2A3548' }));
  roof.quaternion.copy(quat);
  roof.position.y = wallH + 0.07;
  roof.castShadow = true;
  roof.receiveShadow = true;
  inkEdges(roof, '#00FF88', 0.35);
  houseGrp.add(roof);

  // ---- door + windows on the front (sun-facing) wall ----
  if (!doorMat) doorMat = new THREE.MeshLambertMaterial({ color: '#4A3826' });
  if (!windowMat) {
    windowMat = new THREE.MeshLambertMaterial({
      color: '#1A2438', emissive: '#FFB347', emissiveIntensity: 0 });
  }
  const front = (D + 0.5) / 2 + 0.03;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.95, 2.05, 0.1), doorMat);
  door.position.set(face.x * front - u.x * W * 0.26, 1.03, face.z * front - u.z * W * 0.26);
  door.rotation.y = yaw;
  inkEdges(door, '#0E131F', 0.65);
  houseGrp.add(door);
  [W * 0.14, W * 0.36].forEach((along) => {
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.95, 0.08), windowMat);
    win.position.set(face.x * front + u.x * along, wallH * 0.58, face.z * front + u.z * along);
    win.rotation.y = yaw;
    inkEdges(win, '#0E131F', 0.7);
    houseGrp.add(win);
  });

  // ---- chimney on the high (back) slope ----
  const bBack = -(slopeLen / 2 - 0.9);
  const chimney = new THREE.Mesh(
    new THREE.BoxGeometry(0.55, 1.15, 0.55),
    new THREE.MeshLambertMaterial({ color: '#6B5B4B' }));
  chimney.position.set(
    face.x * (bBack * cosT) + u.x * (W * 0.3),
    wallH - bBack * sinT + 0.5,
    face.z * (bBack * cosT) + u.z * (W * 0.3));
  chimney.castShadow = true;
  inkEdges(chimney, '#0E131F', 0.6);
  houseGrp.add(chimney);

  // ---- panels mounted flush on the roof slope ----
  const PW = 1.0, PL = 1.7, GAP = 0.06, ROW_GAP = 0.28;
  const slopeStep = PL + ROW_GAP;
  const cols = Math.max(1, Math.min(40, Math.floor((W + 0.7) / (PW + GAP))));
  const rows = Math.max(1, Math.min(20, Math.floor((slopeLen - 0.3) / slopeStep)));
  const n = Math.min(360, cols * rows);
  const geo = new THREE.BoxGeometry(PW - GAP, 0.045, PL - GAP);
  panelMat = new THREE.MeshStandardMaterial({
    color: '#FFFFFF', roughness: 0.4, metalness: 0.3,
    map: panelTex(), transparent: true, opacity: 1 });
  panelMesh = new THREE.InstancedMesh(geo, panelMat, n);
  panelMesh.castShadow = true;
  panelMesh.receiveShadow = true;
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const nrm = { x: face.x * sinT, y: cosT, z: face.z * sinT };
  const perStringCols = Math.ceil(cols / 3);
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const a = (col - (cols - 1) / 2) * (PW + GAP);
    const b = (row - (rows - 1) / 2) * slopeStep;
    pos.set(
      c.x + u.x * a + face.x * b * cosT + nrm.x * 0.17,
      wallH - b * sinT + nrm.y * 0.17,
      c.z + u.z * a + face.z * b * cosT + nrm.z * 0.17);
    m4.compose(pos, quat, one);
    panelMesh.setMatrixAt(i, m4);
    panelMesh.setColorAt(i, new THREE.Color('#16324F'));
    panelData.push({
      pos: pos.clone(),
      string: Math.min(2, Math.floor(col / perStringCols)),
      shaded: false });
  }
  panelMesh.instanceMatrix.needsUpdate = true;
  if (panelMesh.instanceColor) panelMesh.instanceColor.needsUpdate = true;
  scene.add(panelMesh);
  S._gen = { t: 0 };   // house build-in animation
}

function buildObstacles() {
  const ov = $('scene_overlay');
  S.obs.forEach((o) => {
    const p = ll2m(o.lat, o.lng);
    const h = Math.max(0.3, o.h || 2);
    let w = 1.5;
    if (o.type === 'tree') {
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.16, h * 0.45, 8),
        new THREE.MeshLambertMaterial({ color: '#5A3B22' }));
      trunk.position.y = h * 0.225;
      const canopy = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(0.6, h * 0.28), 12, 10),
        new THREE.MeshLambertMaterial({ color: '#2F6B33', transparent: true, opacity: 0.85 }));
      canopy.position.y = h * 0.45 + h * 0.22;
      inkEdges(canopy, '#FF9800', 0.75);
      grp.add(trunk); grp.add(canopy);
      grp.position.set(p.x, 0, p.z);
      grp.traverse((c) => { c.castShadow = true; });
      obsGroup.add(grp);
      w = Math.max(1.4, h * 0.55);
    } else if (o.type === 'pole') {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, h, 0.14),
        new THREE.MeshLambertMaterial({ color: '#6B7280', transparent: true, opacity: 0.9 }));
      mesh.position.set(p.x, h / 2, p.z);
      inkEdges(mesh, '#FF9800');
      mesh.castShadow = true;
      obsGroup.add(mesh);
      w = 0.35;
    } else { // tank
      const grp = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.65, 0.65, h * 0.7, 14),
        new THREE.MeshLambertMaterial({ color: '#1F3B63', transparent: true, opacity: 0.78 }));
      body.position.y = h * 0.55 + h * 0.35;
      inkEdges(body, '#FF9800');
      const legs = new THREE.Mesh(
        new THREE.BoxGeometry(0.9, h * 0.55, 0.9),
        new THREE.MeshLambertMaterial({ color: '#4A5262' }));
      legs.position.y = h * 0.275;
      inkEdges(legs, '#FF9800', 0.5);
      grp.add(body); grp.add(legs);
      grp.position.set(p.x, 0, p.z);
      grp.traverse((c) => { c.castShadow = true; });
      obsGroup.add(grp);
      w = 1.5;
    }
    // floating mono tag over the obstacle
    if (ov) {
      const tag = document.createElement('div');
      tag.className = 'scene-tag obs';
      tag.textContent = o.type.toUpperCase() + ' ' + h + 'M';
      ov.appendChild(tag);
      obsTags.push({ el: tag, pos: new THREE.Vector3(p.x, h + 0.9, p.z) });
    }
    // coral shadow-footprint quad (updated every applyScene)
    const sgeo = new THREE.PlaneGeometry(1, 1);
    sgeo.rotateX(-Math.PI / 2);
    const smesh = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({
      color: '#FF3B30', transparent: true, opacity: 0.24, depthWrite: false }));
    smesh.position.set(p.x, 0.035, p.z);
    smesh.visible = false;
    scene.add(smesh);
    shadowMeshes.push({ mesh: smesh, x: p.x, z: p.z, h, w });
  });
}

/* ---------- NOAA solar position (scene-grade, offline) ---------- */
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

function sunWorld(az, el, R) {
  const a = az * DEG, e = el * DEG;
  return new THREE.Vector3(R * Math.cos(e) * Math.sin(a), R * Math.sin(e), -R * Math.cos(e) * Math.cos(a));
}

function sunNow() {
  if (!S.W.length) return { az: 180, el: 45 };
  const iso = S.W[S.dayIdx].d;
  const doy = dayOfYearOf(iso);
  // slider shows local wall clock; convert to UTC via longitude offset
  // (good to ~30 min for scene purposes; pvlib stays server-side authority)
  const localH = S.timeSlot * 0.25;
  const utcH = ((localH - CFG.lng / 15) % 24 + 24) % 24;
  return solarPos(doy, utcH, CFG.lat, CFG.lng);
}

function horizonEl(az) {
  if (!S.H || !S.H.points || !S.H.points.length) return -90;
  const pts = S.H.points.slice().sort((a, b) => a.az - b.az);
  // extend query with wrap
  let best = null, bd = 999;
  for (const p of pts) {
    let d = Math.abs(p.az - az);
    d = Math.min(d, 360 - d);
    if (d < bd) { bd = d; best = p; }
  }
  return bd <= 20 ? best.el : -90;
}

function clearArcs() {
  if (!arcGroup) return;
  while (arcGroup.children.length) {
    const c = arcGroup.children.pop();
    if (c.geometry) c.geometry.dispose();
    if (c.material) c.material.dispose();
  }
}

function buildArcs() {
  clearArcs();
  if (!arcGroup) return;
  const iso = S.W.length ? S.W[S.dayIdx].d : CFG.today;
  const doy = dayOfYearOf(iso);
  const addArc = (ddoy, color, opacity, R) => {
    const pts = [];
    for (let h = 0; h <= 24; h += 0.25) {
      const sp = solarPos(ddoy, h, CFG.lat, CFG.lng);
      if (sp.el > -1) pts.push(sunWorld(sp.az, sp.el, R));
    }
    if (pts.length < 2) return;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity });
    arcGroup.add(new THREE.Line(geo, mat));
  };
  addArc(doy, '#00FF88', 0.95, 52);                    // selected day
  addArc(172, '#9AA9C4', 0.30, 52);                    // Jun 21 envelope
  addArc(355, '#9AA9C4', 0.30, 52);                    // Dec 21 envelope
  addArc(79, '#9AA9C4', 0.22, 52);                     // Mar 20 envelope
}

function makeRain() {
  const N = 450;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * SPAN_BASE;
    pos[i * 3 + 1] = Math.random() * 26;
    pos[i * 3 + 2] = (Math.random() - 0.5) * SPAN_BASE;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  rainPts = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#4CC2FF', size: 0.22, transparent: true, opacity: 0.85 }));
  rainPts.visible = false;
  scene.add(rainPts);
}

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

function makeClouds() {
  const tex = softDiscTexture('rgba(230,235,245,.95)', 'rgba(230,235,245,0)');
  for (let i = 0; i < 7; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
    sp.position.set((Math.random() - 0.5) * 90, 20 + Math.random() * 9, (Math.random() - 0.5) * 90);
    sp.scale.set(16 + Math.random() * 14, 7 + Math.random() * 4, 1);
    sp.userData.speed = 0.4 + Math.random() * 0.5;
    cloudGroup.add(sp);
  }
}

function birdTexture() {
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 16;
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = '#0E131F';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(2, 12); ctx.quadraticCurveTo(10, 2, 16, 9);
  ctx.quadraticCurveTo(22, 2, 30, 12);
  ctx.stroke();
  return new THREE.CanvasTexture(cv);
}

function makeBirds() {
  const tex = birdTexture();
  for (let i = 0; i < 4; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false }));
    sp.scale.set(1.6, 0.8, 1);
    sp.userData = { r: 12 + i * 3.5, w: 0.35 + i * 0.06, ph: i * 1.7, y: 14 + i };
    birdGroup.add(sp);
  }
}

/* ---------- client state machine (mirror of API consts) ---------- */
function stateAt(idx) {
  const C = S.C;
  if (!S.W.length || !C.rain_partial_min_mm) {
    return { cur: null, rain7: 0, daysSince: 999, soil: 0, derate: 0, mode: 'normal', lastRain: null };
  }
  const rows = S.W;
  const cur = rows[Math.min(idx, rows.length - 1)];
  let rain7 = 0;
  for (let i = Math.max(0, idx - 6); i <= idx; i++) rain7 += rows[i].precip || 0;
  let last = null;
  for (let i = idx; i >= 0; i--) {
    if ((rows[i].precip || 0) >= C.rain_partial_min_mm) { last = i; break; }
  }
  const daysSince = last === null ? 999 : idx - last;
  let soil = 0;
  for (let i = Math.max(0, idx - 59); i <= idx; i++) {
    const p = rows[i].precip || 0;
    if (p > C.rain_full_mm) soil = 0;
    else if (p >= C.rain_partial_min_mm) soil *= (1 - C.partial_wash_frac);
    else soil = Math.min(C.soil_cap, soil + C.dry_day_accum);
  }
  const tmax = cur.tmax;
  const cloud = cur.cloud;
  const derate = Math.max(0, ((tmax == null ? 0 : tmax) - C.t_ref_c) * Math.abs(C.gamma_pdc_per_c));
  let mode;
  if (rain7 >= C.rain_partial_min_mm) mode = 'rain_clean';
  else if (cloud != null && cloud >= C.cloudy_pct) mode = 'cloudy';
  else if (tmax != null && tmax >= C.hot_tmax_c) mode = 'hot';
  else if (daysSince >= C.dusty_days || soil >= 0.05) mode = 'dusty';
  else mode = 'normal';
  return { cur, rain7, daysSince, soil, derate, mode, lastRain: last === null ? null : rows[last].d };
}

/* ---------- render loop ---------- */
let lastTS = 0;
function animate(ts) {
  requestAnimationFrame(animate);
  if (!sceneOK) return;
  const dt = Math.min(0.05, ((ts || 0) - (lastTS || ts || 0)) / 1000);
  lastTS = ts || 0;
  const t = (ts || 0) / 1000;
  if (S.playing) tickPlay(dt);
  // camera fly-in on first load
  if (S.intro && S.intro.t < 1) {
    S.intro.t = Math.min(1, S.intro.t + dt / 1.3);
    const e = 1 - Math.pow(1 - S.intro.t, 3);
    camera.position.lerpVectors(S.intro.from, S.intro.to, e);
    if (S.intro.t >= 1) controls.enabled = true;
  }
  // house "generate" pop-in after rebuilds
  if (houseGrp && S._gen && S._gen.t < 1) {
    S._gen.t = Math.min(1, S._gen.t + dt / 0.55);
    const g = S._gen.t;
    const c1 = 1.70158, c3 = c1 + 1;
    const e = 1 + c3 * Math.pow(g - 1, 3) + c1 * Math.pow(g - 1, 2);
    houseGrp.scale.setScalar(Math.max(0.001, e));
    if (panelMat) panelMat.opacity = Math.min(1, g * 1.8);
  }
  // radar sweep + sun ring spin/pulse
  if (radarGrp) radarGrp.rotation.y += dt * 0.785;
  if (sunRing) {
    sunRing.rotation.z += dt * 0.9;
    const pulse = 1 + Math.sin(t * 2.2) * 0.07;
    sunRing.scale.set(pulse, pulse, pulse);
  }
  if (sunGlow) {
    const gp = 10.5 + Math.sin(t * 1.7) * 1.2;
    sunGlow.scale.set(gp, gp, 1);
  }
  // clouds drift
  const st = stateAt(S.dayIdx);
  const cloudAmt = st.cur && st.cur.cloud != null ? st.cur.cloud / 100 : 0;
  cloudGroup.children.forEach((c) => {
    c.material.opacity = Math.max(0, cloudAmt - 0.25) * 0.9;
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 60) c.position.x = -60;
  });
  // birds when cloudy
  birdGroup.children.forEach((b) => {
    const u = b.userData;
    b.material.opacity = cloudAmt > 0.5 ? 0.9 : 0;
    b.position.set(Math.cos(t * u.w + u.ph) * u.r, u.y + Math.sin(t * 2 + u.ph) * 0.6, Math.sin(t * u.w + u.ph) * u.r);
  });
  // rain fall
  if (rainPts && rainPts.visible) {
    const p = rainPts.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let y = p.getY(i) - 22 * dt;
      if (y < 0) y = 24 + Math.random() * 4;
      p.setY(i, y);
    }
    p.needsUpdate = true;
  }
  // dust motes drift
  if (dustMotes && dustMotes.material.opacity > 0.01) dustMotes.rotation.y += dt * 0.06;
  // diode-stress flash on shaded panels
  if (panelMesh && panelMesh.instanceColor && S._shaded && S._shaded.count && (S._sunEl || 0) > 0) {
    const k = (Math.sin(t * 5) + 1) / 2;
    _flashC.set('#FF3B30').lerp(_tmpC.set('#FF9800'), k * 0.55);
    for (let i = 0; i < panelData.length; i++) {
      if (panelData[i].shaded) panelMesh.setColorAt(i, _flashC);
    }
    panelMesh.instanceColor.needsUpdate = true;
  }
  updateTags();
  controls.update();
  renderer.render(scene, camera);
}

/* ---------- scene state application ---------- */
function applyScene() {
  if (!sceneOK || !S.W.length) return;
  const st = stateAt(S.dayIdx);
  const { az, el } = sunNow();
  const blocked = el < horizonEl(az);
  const night = el <= 0;
  S._sunAz = az; S._sunEl = el;
  if (sunRig) {
    sunRig.position.copy(sunWorld(az, el, 52));
    sunRig.visible = !night;
  }
  sunLight.position.copy(sunWorld(az, el, 90));
  sunLight.target.position.set(0, 0, 0);
  const boost = blocked || night ? 0 : Math.min(1, Math.max(0.05, Math.sin(Math.max(el, 0) * DEG)));
  sunLight.intensity = night ? 0 : (blocked ? 0 : boost * 1.25);
  ambLight.intensity = night ? 0.10 : (blocked ? 0.42 : 0.22);
  hemiLight.intensity = night ? 0.18 : (st.mode === 'cloudy' ? 0.75 : 0.5);
  const sky = new THREE.Color('#0E131F');
  if (!night) {
    const day = new THREE.Color(st.mode === 'cloudy' ? '#5A6472' : '#2E6FBF');
    const dawn = new THREE.Color('#FF9800');
    const k = Math.min(1, Math.max(0, el / 20));
    sky.copy(dawn).lerp(day, k);
    if (el < 4) sky.lerp(new THREE.Color('#1B2440'), 0.4);
  }
  scene.background = sky;
  if (scene.fog) scene.fog.color.copy(sky);
  // gradient sky dome palette (changes with time of day + weather)
  const skyKey = night ? 'night' : (el < 8 ? 'dusk' : (st.mode === 'cloudy' ? 'cloudy' : 'day'));
  if (skyKey !== S._skyKey) { S._skyKey = skyKey; paintSky(skyKey); }
  // moon opposite the sun, up only at night
  if (moonRig) {
    moonRig.visible = night;
    if (night) moonRig.position.copy(sunWorld((az + 180) % 360, Math.max(14, -el * 0.8), 52));
  }
  // windows glow after dark
  if (windowMat) windowMat.emissiveIntensity = night ? 1.5 : 0;
  $('twin_scene').classList.toggle('hot', st.mode === 'hot');

  // coral shadow footprints (the "shadow stalker" overlay)
  shadowMeshes.forEach((s) => {
    if (night || el < 3) { s.mesh.visible = false; return; }
    const len = Math.min(70, s.h / Math.tan(el * DEG));
    if (len < 0.4) { s.mesh.visible = false; return; }
    const dxs = -Math.sin(az * DEG), dzs = Math.cos(az * DEG);
    s.mesh.visible = true;
    s.mesh.scale.set(s.w, 1, len);
    s.mesh.position.set(s.x + dxs * len / 2, 0.035, s.z + dzs * len / 2);
    s.mesh.rotation.y = Math.atan2(dxs, dzs);
  });

  // stars + dust motes
  if (stars) stars.material.opacity = night ? 0.85 : 0;
  if (dustMotes) dustMotes.material.opacity = Math.min(0.55, (st.soil / 0.15) * 0.55);

  // panel colours: clean ↔ dusty, shaded coral, hot amber tint
  if (panelMesh && panelMesh.instanceColor) {
    const clean = new THREE.Color('#16324F');
    const dust = new THREE.Color('#9A8B6A');
    const coral = new THREE.Color('#FF3B30');
    const amber = new THREE.Color('#FF9800');
    const mixK = Math.min(1, st.soil / 0.15);
    const base = clean.clone().lerp(dust, mixK);
    for (let i = 0; i < panelData.length; i++) {
      const c = base.clone();
      if (panelData[i].shaded && !night) c.lerp(coral, 0.85);
      if (st.derate > 3 && !night) c.lerp(amber, Math.min(0.45, st.derate / 25));
      panelMesh.setColorAt(i, c);
    }
    panelMesh.instanceColor.needsUpdate = true;
  }
  refreshShading();

  // diode tag over the array
  const sh = S._shaded || { count: 0, strings: {} };
  const strKeys = Object.keys(sh.strings);
  if (!night && strKeys.length && $('scene_overlay')) {
    if (!diodeTag) {
      diodeTag = document.createElement('div');
      diodeTag.className = 'scene-tag diode';
      diodeTag._pos = new THREE.Vector3(0, 2.6, 0);
      $('scene_overlay').appendChild(diodeTag);
    }
    diodeTag.textContent = 'S' + (Number(strKeys[0]) + 1) + ' DIODE CONDUCTING';
  } else if (diodeTag) { diodeTag.remove(); diodeTag = null; }

  updateHUD(st, az, el, blocked, night);
  const sig = [st.cur && st.cur.d, st.mode, Math.round(st.soil * 100), Math.round(st.derate),
    st.daysSince, sh.count, strKeys.join(','), blocked, night].join('|');
  if (sig !== S._logSig) { S._logSig = sig; updateLog(st, az, el, blocked, night); }
}

function refreshShading() {
  if (!sceneOK || !panelData.length || !obsGroup) return;
  const { az, el } = sunNow();
  const blocked = el < horizonEl(az);
  const dir = sunWorld(az, el, 1).normalize();
  const targets = obsGroup.children.filter((c) => c !== groundMesh);
  if (houseGrp) targets.push(houseGrp);
  let shadedCount = 0;
  const strHit = {};
  for (let i = 0; i < panelData.length; i++) {
    let shaded = blocked || el <= 0;
    if (!shaded) {
      raycaster.set(panelData[i].pos, dir);
      raycaster.far = 140;
      const hits = raycaster.intersectObjects(targets, true);
      shaded = hits.length > 0;
    }
    panelData[i].shaded = shaded;
    if (shaded && el > 0) {
      shadedCount++;
      strHit[panelData[i].string] = (strHit[panelData[i].string] || 0) + 1;
    }
  }
  S._shaded = { count: shadedCount, strings: strHit };
}

/* ---------- HUD + log ---------- */
function fmtTime(slot) {
  const h = Math.floor(slot * 0.25), m = (slot % 4) * 15;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function cell(lab, val, cls) {
  return '<div class="hud-cell" data-lab="' + lab + '"><span class="lab">' + lab +
    '</span><span class="val ' + (cls || '') + '">' + val + '</span></div>';
}

function updateHUD(st, az, el, blocked, night) {
  const hud = $('scene_hud');
  if (!hud) return;
  const iso = st.cur ? st.cur.d : '—';
  const soilPct = (st.soil * 100).toFixed(1);
  const sh = S._shaded || { count: 0, strings: {} };
  const strKeys = Object.keys(sh.strings);
  const ghi = st.cur ? (st.cur.ghi || 0) : 0;
  const bleed = (S.C.inr_per_kwh || 8) * CFG.kwp * ghi * (S.C.pr_scene || 0.8) * st.soil;
  const modeCls = { hot: 'badv', dusty: 'warnv', cloudy: 'warnv' }[st.mode] || '';
  const shadowTxt = night ? 'night' : (sh.count ? sh.count + 'p' + (strKeys.length ? ' · S' + (Number(strKeys[0]) + 1) : '') : 'clear');
  const shadowCls = !night && sh.count ? 'badv' : '';
  hud.innerHTML =
    cell('date · time', iso.slice(5) + ' ' + fmtTime(S.timeSlot)) +
    cell('sun', el.toFixed(0) + '° ' + az.toFixed(0) + (blocked && !night ? ' blk' : ''), blocked && !night ? 'warnv' : '') +
    cell('mode', st.mode.replace('_', ' '), modeCls) +
    cell('soil', soilPct + '%', st.soil >= 0.05 ? 'warnv' : '') +
    cell('derate', '−' + st.derate.toFixed(1) + '%', st.derate > 5 ? 'badv' : '') +
    cell('shadow', shadowTxt, shadowCls) +
    cell('bleed', bleed >= 0.5 ? '₹' + Math.round(bleed) + '/d' : '₹0', bleed >= 1 ? 'warnv' : '');
  // flash cells whose value changed
  const prev = S._hudPrev || {};
  const next = {};
  hud.querySelectorAll('.hud-cell').forEach((c) => {
    const lab = c.dataset.lab;
    const v = c.querySelector('.val').textContent;
    next[lab] = v;
    if (prev[lab] !== undefined && prev[lab] !== v) {
      c.classList.remove('flash');
      void c.offsetWidth;
      c.classList.add('flash');
    }
  });
  S._hudPrev = next;
}

function updateLog(st, az, el, blocked, night) {
  const log = $('twin_log');
  const lines = [];
  const iso = st.cur ? st.cur.d : CFG.today;
  lines.push(['n', iso + ' · mode=' + st.mode + ' · soiling deficit ' + (st.soil * 100).toFixed(1) + '%']);
  if (st.rain7 >= (S.C.rain_partial_min_mm || 1)) {
    const full = st.soil < 0.001;
    lines.push(['', 'Rain on ' + st.lastRain + ' ' + (full ? 'fully washed the array — soiling reset'
      : 'partially washed panels — tiered wash removed ' + Math.round((S.C.partial_wash_frac || 0.3) * 100) + '% of the dust mass')]);
  }
  if (st.cur && st.cur.cloud != null && st.cur.cloud >= (S.C.cloudy_pct || 70)) {
    lines.push(['n', 'Cloudy (' + st.cur.cloud + '% cover) — diffuse share up, expect lower kWh/m², not a fault. Birds agree.']);
  }
  if (st.derate > 0.5) {
    lines.push(['w', 'Cells running hot — ' + st.cur.tmax + '°C ambient, −' + st.derate.toFixed(1) + '% thermal derate (γ=' + (S.C.gamma_pdc_per_c) + '%/°C, ref ' + S.C.t_ref_c + '°C)']);
  }
  if (st.daysSince >= (S.C.dusty_days || 10) && st.soil > 0.04) {
    const ghi = st.cur.ghi || 5;
    const bleed = CFG.kwp * ghi * (S.C.pr_scene || 0.8) * st.soil * (S.C.inr_per_kwh || 8);
    lines.push(['w', 'No wash in ' + st.daysSince + ' days — soiling at ' + (st.soil * 100).toFixed(1) + '%, ≈₹' + bleed.toFixed(0) + '/day bleeding']);
  }
  const sh = S._shaded || { count: 0, strings: {} };
  if (!night && sh.count) {
    Object.keys(sh.strings).forEach((k) => {
      lines.push(['b', 'String S' + (Number(k) + 1) + ' bypass diode conducting — ' + sh.strings[k] + ' panel(s) in shade, hotspot stress']);
    });
  }
  if (blocked && !night) {
    lines.push(['n', 'Terrain horizon (' + (S.H && S.H.points ? S.H.points.length + ' pts' : 'none') + ') clips sun below ' + horizonEl(az).toFixed(1) + '° at this azimuth']);
  }
  if (night) lines.push(['n', 'Sun below horizon — scene shows ambient only; tomorrow starts ' + (st.cur ? nextRainText() : '')]);
  log.innerHTML = lines.map((l, i) =>
    '<div class="' + l[0] + '" style="animation-delay:' + (i * 70) + 'ms">' + l[1] + '</div>').join('');
}

function nextRainText() {
  for (let i = S.dayIdx + 1; i < S.W.length; i++) {
    if ((S.W[i].precip || 0) >= (S.C.rain_partial_min_mm || 1)) return 'with rain on ' + S.W[i].d;
  }
  return 'dry — no rain left in this year of ERA5';
}

/* ---------- controls ---------- */
function setDay(idx, opts) {
  S.dayIdx = Math.max(0, Math.min(S.W.length - 1, idx));
  $('day_slider').value = S.dayIdx + 1;
  $('day_label').textContent = S.W.length ? S.W[S.dayIdx].d : '—';
  buildArcs();
  applyScene();
}

function setSlot(slot) {
  S.timeSlot = Math.max(0, Math.min(95, slot | 0));
  $('time_slider').value = S.timeSlot;
  $('time_label').textContent = fmtTime(S.timeSlot);
  applyScene();
}

function tickPlay(dt) {
  if (S.sweeping) return;
  S._acc = (S._acc || 0) + dt * 14; // ~14 slots/s ≈ 3.5 min per day
  while (S._acc >= 1) {
    S._acc -= 1;
    if (S.timeSlot >= 95) {
      setSlot(0);
      if (S.dayIdx < S.W.length - 1) setDay(S.dayIdx + 1);
      else stopPlay();
    } else setSlot(S.timeSlot + 1);
  }
}

function startPlay() {
  S.playing = true; S.sweeping = false;
  $('btn_play').textContent = '⏸ PAUSE';
  $('btn_sweep').textContent = '↻ SWEEP YEAR';
}
function stopPlay() {
  S.playing = false; S.sweeping = false;
  clearInterval(S.sweepTimer);
  $('btn_play').textContent = '▶ PLAY DAY';
  $('btn_sweep').textContent = '↻ SWEEP YEAR';
}

/* ---------- sim chart ---------- */
function drawSim() {
  const el = $('sim_chart');
  const sum = $('sim_summary');
  if (!S.SIM || S.SIM.error || !S.SIM.months || !S.SIM.months.length) {
    sum.textContent = '6-month scenario unavailable (' + ((S.SIM && S.SIM.error) || 'no data') + ')';
    return;
  }
  const months = S.SIM.months;
  if (typeof Chart === 'undefined') { sum.textContent = 'chart library unavailable'; return; }
  new Chart(el, {
    data: {
      labels: months.map((m) => m.month),
      datasets: [
        { type: 'bar', label: '₹ bled (cum)', data: months.map((m) => m.cum_inr),
          backgroundColor: '#FF9800', borderColor: '#0E131F', borderWidth: 2, yAxisID: 'y' },
        { type: 'line', label: 'soiling ratio', data: months.map((m) => m.soil),
          borderColor: '#FF3B30', backgroundColor: '#FF3B30', borderWidth: 3, pointRadius: 4,
          pointBackgroundColor: '#0E131F', pointBorderColor: '#FF3B30', yAxisID: 'y1', tension: 0.25 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#9AA9C4', font: { family: 'Space Mono', size: 11 } } } },
      scales: {
        x: { ticks: { color: '#9AA9C4', font: { family: 'Space Mono', size: 10 } },
          grid: { color: 'rgba(154,169,196,.15)' } },
        y: { position: 'left', ticks: { color: '#FF9800', font: { family: 'Space Mono', size: 10 } },
          grid: { color: 'rgba(154,169,196,.15)' }, title: { display: true, text: '₹ cum', color: '#FF9800' } },
        y1: { position: 'right', min: 0.7, max: 1.0,
          ticks: { color: '#FF3B30', font: { family: 'Space Mono', size: 10 } }, grid: { display: false },
          title: { display: true, text: 'soil ratio', color: '#FF3B30' } },
      },
    },
  });
  sum.innerHTML = '<b>₹' + Math.round(S.SIM.total_inr).toLocaleString('en-IN') + '</b> bled over 6 rain-free months · ' +
    S.SIM.total_kwh + ' kWh lost · soiling bottoms at ' + (S.SIM.final_soil != null ? (100 - S.SIM.final_soil * 100).toFixed(1) + '% loss' : '—') +
    ' · HSU deposition, PR ' + S.SIM.pr_assumed;
}

/* ---------- data ---------- */
async function loadData() {
  const status = $('scrub_status');
  status.textContent = 'fetching twin data…';
  try {
    const r = await fetch(CFG.api);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    S.data = d;
    S.W = (d.weather_year || []).slice().sort((a, b) => (a.d < b.d ? -1 : 1));
    S.C = d.consts || {};
    S.H = d.horizon;
    S.SIM = d.sim6m;
    if (!S.W.length) {
      status.textContent = 'ERA5 unavailable — neutral weather fallback';
      S.W = [];
      return;
    }
    const want = d.date || CFG.today;
    let idx = S.W.findIndex((r2) => r2.d === want);
    if (idx < 0) idx = S.W.findIndex((r2) => r2.d <= CFG.today);
    if (idx < 0) idx = S.W.length - 1;
    $('day_slider').max = S.W.length;
    setDay(idx);
    // verify client state machine against server for the initial day
    const cs = stateAt(idx);
    if (d.state && d.state.mode !== cs.mode) {
      console.info('twin: client mode', cs.mode, 'server', d.state.mode);
    }
    drawSim();
    status.textContent = 'ERA5 ' + S.W.length + ' days · sun via NOAA (pvlib on API) · horizon ' +
      (S.H && S.H.points ? S.H.points.length + ' pts' : 'none');
  } catch (e) {
    status.textContent = 'twin API failed: ' + e.message + ' — map + draw still work';
  }
}

/* ---------- boot ---------- */
function boot() {
  if (!loadGeom()) {
    S.poly = presetPoly();
    S.obs = [];
    saveGeom();
  }
  initMap();
  initScene();
  rebuildScene();
  updateStorageChip();

  $('btn_array').onclick = () => {
    if (S.mode === 'array' && S.poly.length >= 3) {
      S.mode = 'idle';
      $('btn_array').textContent = 'DRAW ARRAY';
      $('btn_array').classList.remove('active');
      $('draw_help').textContent = 'array saved — ' + S.poly.length + ' corners';
      saveGeom();
      rebuildScene();
      return;
    }
    S.mode = 'array';
    S.poly = [];
    redrawGeomLayers();
    $('btn_array').textContent = 'FINISH ARRAY';
    $('btn_array').classList.add('active');
    $('btn_obstacle').classList.remove('active');
    $('draw_help').textContent = 'click map to set corners (3+), then press FINISH';
    rebuildScene();
  };
  $('btn_obstacle').onclick = () => {
    if (S.mode === 'array' && S.poly.length >= 3) { S.mode = 'idle'; saveGeom(); rebuildScene(); }
    S.mode = 'obs';
    $('btn_obstacle').classList.add('active');
    $('btn_array').classList.remove('active');
    $('btn_array').textContent = 'DRAW ARRAY';
    $('obs_form').hidden = false;
    $('obs_pending').textContent = 'click map to place';
    $('draw_help').textContent = 'obstacle mode: click the map next to the array, set height, CONFIRM';
  };
  $('obs_confirm').onclick = () => {
    if (!S.pending) { $('obs_pending').textContent = 'click the map first'; return; }
    S.obs.push({
      lat: S.pending.lat, lng: S.pending.lng,
      h: parseFloat($('obs_h').value) || 2.5,
      type: $('obs_type').value,
    });
    S.pending = null;
    S.mode = 'idle';
    $('btn_obstacle').classList.remove('active');
    $('obs_form').hidden = true;
    $('draw_help').textContent = 'obstacle added — it will cast real shadows at sun angles';
    saveGeom();
    redrawGeomLayers();
    rebuildScene();
  };
  $('btn_preset').onclick = () => {
    S.poly = presetPoly();
    S.mode = 'idle';
    $('btn_array').classList.remove('active');
    $('btn_obstacle').classList.remove('active');
    $('btn_array').textContent = 'DRAW ARRAY';
    redrawGeomLayers();
    saveGeom();
    rebuildScene();
  };
  $('btn_clear').onclick = () => {
    S.poly = []; S.obs = []; S.mode = 'idle';
    $('btn_array').classList.remove('active');
    $('btn_obstacle').classList.remove('active');
    $('btn_array').textContent = 'DRAW ARRAY';
    $('obs_form').hidden = true;
    redrawGeomLayers();
    saveGeom();
    rebuildScene();
  };

  $('day_slider').oninput = (e) => { stopPlay(); setDay(Number(e.target.value) - 1); };
  $('time_slider').oninput = (e) => { stopPlay(); setSlot(Number(e.target.value)); };
  $('btn_noon').onclick = () => { stopPlay(); setSlot(48); };
  $('btn_play').onclick = () => {
    if (S.playing && !S.sweeping) stopPlay();
    else { stopPlay(); startPlay(); }
  };
  $('btn_sweep').onclick = () => {
    if (S.sweeping) { stopPlay(); return; }
    stopPlay();
    S.playing = true; S.sweeping = true;
    $('btn_sweep').textContent = '⏸ STOP SWEEP';
    setSlot(48);
    S.sweepTimer = setInterval(() => {
      if (S.dayIdx < S.W.length - 1) setDay(S.dayIdx + 1);
      else stopPlay();
    }, 650);
  };

  setSlot(48);
  loadData();
}

boot();
