import * as THREE from 'three';
import { X_SCALE, Z_SCALE, RACKET_HEIGHT, RACKET_RADIUS, RACKET_FACE_DEPTH, BALL_RADIUS, racketNormal } from './physics.js';

const TABLE_Y = 0.76;
const world = (x, y) => new THREE.Vector3((x - 500) * X_SCALE, TABLE_Y, (y - 400) * Z_SCALE);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const TRAIL_LIFETIME = 0.7;
const TRAIL_CAPACITY = 38;

// The vertical Magnus component distinguishes topspin from backspin regardless
// of which end is hitting; turning the guest's view never changes this label.
function spinColor(ball) {
  const wx = finite(ball.spinX); const wy = finite(ball.spinY); const wz = finite(ball.spinZ);
  const vx = finite(ball.vx) * X_SCALE; const vz = finite(ball.vy) * Z_SCALE;
  const speed = Math.hypot(vx, vz);
  const topspin = speed > 0.001 ? (wx * vz - wz * vx) / speed : wx;
  if (Math.hypot(wx, wy, wz) < 4) return '#fff1cf';
  if (Math.abs(wy) > Math.abs(topspin) * 1.1) return '#ffd18a';
  return topspin >= 0 ? '#ff9e7c' : '#a3dcf1';
}

function fallbackScene(canvas, error) {
  const message = document.createElement('div');
  message.setAttribute('role', 'status');
  message.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:30px;background:#deebcc;color:#173f32;text-align:center;font:600 16px system-ui;z-index:2;pointer-events:none';
  const title = document.createElement('strong');
  title.textContent = '这个设备暂时无法开启 3D 球场';
  const detail = document.createElement('span');
  detail.style.cssText = 'font-size:12px;line-height:1.8;font-weight:400;max-width:250px';
  detail.textContent = '请开启浏览器硬件加速，或使用支持 WebGL 的浏览器再试一次。';
  message.append(title, detail);
  canvas.parentElement?.append(message);
  console.warn('3D court could not initialize:', error);
  return {
    render() {}, resize() {},
    pointerWorld(clientX, clientY, offset = 0) {
      const r = canvas.getBoundingClientRect();
      return { x: ((clientX - r.left) / r.width) * 1000, y: ((clientY - offset - r.top) / r.height) * 800 };
    },
    destroy() { message.remove(); },
  };
}

export function createScene3D(canvas) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  } catch (error) { return fallbackScene(canvas, error); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.23;
  // Baked soft contact shadows keep the scene light enough for phones.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce7c8');
  scene.fog = new THREE.Fog('#dce7c8', 7, 15);
  const camera = new THREE.PerspectiveCamera(47, 1, 0.05, 30);
  const target = new THREE.Vector3(0, 0.66, 0);
  const cameraBase = new THREE.Vector3(0, 2.6, 3.2);
  camera.position.copy(cameraBase);
  camera.lookAt(target);
  scene.add(new THREE.HemisphereLight('#fff8df', '#66856c', 2.2));
  const sun = new THREE.DirectionalLight('#fff4db', 3.3);
  sun.position.set(-3, 6, 3); scene.add(sun);
  const rim = new THREE.DirectionalLight('#c4dfd1', 1.3);
  rim.position.set(3, 3, -4); scene.add(rim);
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  function geometry(g) { geometries.add(g); return g; }
  function material(color, extra = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, ...extra });
    materials.add(m); return m;
  }
  function mesh(g, m, position, parent = scene) {
    const object = new THREE.Mesh(g, m);
    if (position) object.position.set(...position);
    parent.add(object); return object;
  }
  function box(w, h, d, m, x, y, z, parent = scene) { return mesh(geometry(new THREE.BoxGeometry(w, h, d)), m, [x, y, z], parent); }
  function textureCanvas(w, h, paint) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
    textures.add(texture); return texture;
  }
  const softShadowTexture = textureCanvas(128, 128, (ctx, w, h) => {
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 3, w / 2, h / 2, w / 2);
    gradient.addColorStop(0, 'rgba(5,32,24,.6)'); gradient.addColorStop(0.4, 'rgba(5,32,24,.3)'); gradient.addColorStop(1, 'rgba(5,32,24,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  });
  function shadow(w, d, y, opacity = 1) {
    const m = new THREE.MeshBasicMaterial({ map: softShadowTexture, transparent: true, opacity, depthWrite: false }); materials.add(m);
    const object = mesh(geometry(new THREE.PlaneGeometry(w, d)), m, [0, y, 0]);
    object.rotation.x = -Math.PI / 2; return object;
  }
  const cream = material('#eee8cf');
  const steel = material('#1a3a31', { roughness: 0.45, metalness: 0.2 });
  const oak = material('#b18a59');
  const oakDark = material('#8b6a45');
  const floor = material('#bdcca4', { roughness: 0.95 });
  const floorMesh = mesh(geometry(new THREE.PlaneGeometry(30, 30)), floor, [0, -0.01, 0]); floorMesh.rotation.x = -Math.PI / 2;
  // Inlaid court markings and a muted herringbone sports-hall floor.
  const floorLines = material('#e9eccd', { roughness: 1 });
  for (const x of [-1.75, 1.75]) box(0.025, 0.003, 5.2, floorLines, x, 0.002, 0);
  for (const z of [-2.6, 2.6]) box(3.525, 0.003, 0.025, floorLines, 0, 0.002, z);
  const seams = material('#a7ba91', { transparent: true, opacity: 0.25 });
  for (let x = -6; x <= 6; x += 0.6) box(0.006, 0.002, 11, seams, x, 0, 0);
  const backWall = material('#174638');
  box(12, 3.2, 0.14, backWall, 0, 1.6, -4.7);
  box(12, 0.13, 0.2, oak, 0, 0.13, -4.57);
  for (const x of [-4.5, -2.9, 2.9, 4.5]) box(0.018, 2.8, 0.025, material('#66806a'), x, 1.65, -4.61);
  const signTexture = textureCanvas(1024, 384, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#edf0d6'; ctx.textAlign = 'center';
    ctx.font = '900 126px Arial, sans-serif'; ctx.fillText('SPIN CLUB', w / 2, 180);
    ctx.font = '500 23px Arial, sans-serif'; ctx.letterSpacing = '6px'; ctx.fillStyle = '#b5cba7';
    ctx.fillText('PLAY WITH FEEL.  /  EST. 2026', w / 2, 246);
  });
  const signMaterial = new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, depthWrite: false }); materials.add(signMaterial);
  mesh(geometry(new THREE.PlaneGeometry(3.05, 1.14)), signMaterial, [0, 0.9, -4.61]);
  // Club benches, wall sconces and a spare-ball basket provide depth cues.
  for (const side of [-1, 1]) {
    const x = side * 2.8;
    box(0.44, 0.09, 2.6, oak, x, 0.44, -1.8);
    box(0.07, 0.38, 0.1, steel, x - 0.15, 0.19, -2.7);
    box(0.07, 0.38, 0.1, steel, x + 0.15, 0.19, -0.9);
    box(0.07, 0.38, 0.1, steel, x - 0.15, 0.19, -0.9);
    box(0.07, 0.38, 0.1, steel, x + 0.15, 0.19, -2.7);
    const sconce = material('#fff2bd', { emissive: '#fff0b8', emissiveIntensity: 0.8 });
    box(0.045, 0.55, 0.06, sconce, side * 2.1, 2.15, -4.56);
  }
  const tableShadow = shadow(3.6, 5.3, 0.008, 0.65);
  tableShadow.position.z = 0.12;
  box(1.59, 0.075, 2.8, oakDark, 0, 0.695, 0);
  box(1.56, 0.045, 2.77, oak, 0, 0.731, 0);
  const tableTexture = textureCanvas(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1d5947'; ctx.fillRect(0, 0, w, h);
    let random = 7;
    for (let i = 0; i < 7000; i++) { random = (random * 16807) % 2147483647; const x = random % w; random = (random * 16807) % 2147483647; const y = random % h; ctx.fillStyle = i % 2 ? '#ffffff08' : '#052d2209'; ctx.fillRect(x, y, 1, 1); }
  });
  const tableMaterial = material('#ffffff', { map: tableTexture, roughness: 0.82 });
  box(1.525, 0.024, 2.74, tableMaterial, 0, TABLE_Y - 0.012, 0);
  const border = material('#eeefd7', { roughness: 0.65 });
  for (const x of [-0.75, 0.75]) box(0.014, 0.003, 2.725, border, x, TABLE_Y + 0.001, 0);
  for (const z of [-1.357, 1.357]) box(1.5, 0.003, 0.014, border, 0, TABLE_Y + 0.001, z);
  box(0.007, 0.002, 2.69, border, 0, TABLE_Y + 0.002, 0);
  // Genuine wooden and metal table undercarriage, visible from the player camera.
  for (const x of [-0.58, 0.58]) {
    for (const z of [-0.98, 0.98]) {
      const leg = box(0.065, 0.69, 0.065, steel, x, 0.35, z);
      leg.rotation.z = x > 0 ? -0.04 : 0.04;
      box(0.095, 0.035, 0.095, oakDark, x * 1.025, 0.025, z);
    }
    box(0.045, 0.05, 2.05, steel, x, 0.31, 0);
  }
  box(1.18, 0.045, 0.045, steel, 0, 0.25, 1.0);
  box(1.18, 0.045, 0.045, steel, 0, 0.25, -1.0);
  const frontBadgeTexture = textureCanvas(512, 96, (ctx, w, h) => {
    ctx.fillStyle = '#e8e9cc'; ctx.textAlign = 'center'; ctx.font = '700 48px Arial'; ctx.fillText('S / C    —    01', w / 2, 64);
  });
  const badgeMaterial = new THREE.MeshBasicMaterial({ map: frontBadgeTexture, transparent: true }); materials.add(badgeMaterial);
  mesh(geometry(new THREE.PlaneGeometry(0.42, 0.075)), badgeMaterial, [0, 0.688, 1.407]);
  // A mesh net made from one line buffer, with a solid top tape and wooden posts.
  const netPoints = [];
  for (let x = -0.8; x <= 0.8; x += 0.028) netPoints.push(x, TABLE_Y + 0.012, 0, x, TABLE_Y + 0.153, 0);
  for (let y = TABLE_Y + 0.012; y <= TABLE_Y + 0.153; y += 0.023) netPoints.push(-0.8, y, 0, 0.8, y, 0);
  const netGeometry = geometry(new THREE.BufferGeometry()); netGeometry.setAttribute('position', new THREE.Float32BufferAttribute(netPoints, 3));
  const netMaterial = new THREE.LineBasicMaterial({ color: '#d8e3d1', transparent: true, opacity: 0.65 }); materials.add(netMaterial);
  scene.add(new THREE.LineSegments(netGeometry, netMaterial));
  const netFabric = material('#c9d8c3', { transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false });
  mesh(geometry(new THREE.PlaneGeometry(1.6, 0.145)), netFabric, [0, TABLE_Y + 0.078, 0]);
  box(1.65, 0.014, 0.016, cream, 0, TABLE_Y + 0.157, 0);
  for (const x of [-0.82, 0.82]) {
    box(0.028, 0.2, 0.028, cream, x, TABLE_Y + 0.087, 0);
    box(0.07, 0.035, 0.085, steel, x, TABLE_Y - 0.02, 0);
  }

  function racket(self) {
    const group = new THREE.Group(); scene.add(group);
    const woodEdge = mesh(geometry(new THREE.CylinderGeometry(RACKET_RADIUS, RACKET_RADIUS, RACKET_FACE_DEPTH * 1.2, 40)), oak, [0, 0, 0], group); woodEdge.rotation.x = Math.PI / 2;
    const rubberMaterial = material(self ? '#fb7758' : '#f0dfac', { roughness: 0.9 });
    const rubberRadius = RACKET_RADIUS * 0.955;
    const rubber = mesh(geometry(new THREE.CylinderGeometry(rubberRadius, rubberRadius, RACKET_FACE_DEPTH * 0.4, 40)), rubberMaterial, [0, 0, RACKET_FACE_DEPTH * 0.8], group); rubber.rotation.x = Math.PI / 2;
    const back = mesh(geometry(new THREE.CylinderGeometry(rubberRadius, rubberRadius, RACKET_FACE_DEPTH * 0.4, 40)), material('#224b3c'), [0, 0, -RACKET_FACE_DEPTH * 0.8], group); back.rotation.x = Math.PI / 2;
    box(RACKET_RADIUS * 0.32, RACKET_RADIUS * 1.34, RACKET_FACE_DEPTH * 1.7, oak, 0, -RACKET_RADIUS * 1.43, 0, group);
    box(RACKET_RADIUS * 0.09, RACKET_RADIUS * 1.07, RACKET_FACE_DEPTH * 1.9, oakDark, 0, -RACKET_RADIUS * 1.52, 0, group);
    box(RACKET_RADIUS * 0.35, RACKET_RADIUS * 0.18, RACKET_FACE_DEPTH * 2, steel, 0, -RACKET_RADIUS * 1.9, 0, group);
    const markMaterial = new THREE.MeshBasicMaterial({ color: self ? '#ffeacb' : '#65774e' }); materials.add(markMaterial);
    const mark = mesh(geometry(new THREE.RingGeometry(RACKET_RADIUS * 0.115, RACKET_RADIUS * 0.145, 20)), markMaterial, [0, -RACKET_RADIUS * 0.47, RACKET_FACE_DEPTH + 0.0008], group);
    const halo = shadow(RACKET_RADIUS * 3.65, RACKET_RADIUS * 3.4, TABLE_Y + 0.006, 0.45);
    return { group, rubberMaterial, markMaterial, halo, mark };
  }
  const paddles = [racket(true), racket(false)];
  // Broad, contrasting markings stay visible on a small phone screen and make actual rotation readable.
  const ballTexture = textureCanvas(256, 128, (ctx, w, h) => {
    ctx.fillStyle = '#fff8df'; ctx.fillRect(0, 0, w, h);
    for (const x of [28, 156]) {
      ctx.fillStyle = '#ed7352'; ctx.fillRect(x, 0, 21, h);
      ctx.fillStyle = '#174638'; ctx.fillRect(x + 21, 0, 9, h);
    }
    ctx.fillStyle = '#174638';
    for (const x of [91, 219]) { ctx.beginPath(); ctx.ellipse(x, h / 2, 11, 15, 0, 0, Math.PI * 2); ctx.fill(); }
  });
  const ballMaterial = material('#ffffff', { map: ballTexture, roughness: 0.45 });
  const sphere = mesh(geometry(new THREE.SphereGeometry(BALL_RADIUS, 24, 18)), ballMaterial, [0, TABLE_Y + 0.2, 0.9]);
  const ballShadow = shadow(0.2, 0.2, TABLE_Y + 0.005, 0.7);
  const bounceMaterial = new THREE.MeshBasicMaterial({ color: '#ffe6bb', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }); materials.add(bounceMaterial);
  const bounceRing = mesh(geometry(new THREE.RingGeometry(BALL_RADIUS * 0.8, BALL_RADIUS * 1.15, 32)), bounceMaterial, [0, TABLE_Y + 0.004, 0]); bounceRing.rotation.x = -Math.PI / 2;
  const spinMaterial = new THREE.MeshBasicMaterial({ color: '#ffab79', transparent: true, opacity: 0, depthWrite: false }); materials.add(spinMaterial);
  const spinRing = new THREE.Group(); scene.add(spinRing);
  const spinRadius = BALL_RADIUS + 0.024;
  const spinArc = Math.PI * 1.65;
  const spinArcMesh = mesh(geometry(new THREE.TorusGeometry(spinRadius, 0.0028, 5, 36, spinArc)), spinMaterial, [0, 0, 0], spinRing);
  spinArcMesh.rotation.x = -Math.PI / 2;
  // Reuse the removed seam's draw call for an arrow that distinguishes left spin from right spin.
  const spinArrow = mesh(geometry(new THREE.ConeGeometry(0.0075, 0.019, 6)), spinMaterial, [0, 0, 0], spinRing);
  const arrowAxis = new THREE.Vector3(0, 1, 0);
  const arrowDirection = new THREE.Vector3();
  spinArrow.position.set(Math.cos(spinArc) * spinRadius, 0, -Math.sin(spinArc) * spinRadius);
  arrowDirection.set(-Math.sin(spinArc), 0, -Math.cos(spinArc));
  spinArrow.quaternion.setFromUnitVectors(arrowAxis, arrowDirection);
  const angularVelocity = new THREE.Vector3();
  const spinAxis = new THREE.Vector3();
  const angularStep = new THREE.Quaternion();
  const ringAxisRotation = new THREE.Quaternion();
  const ringPhaseRotation = new THREE.Quaternion();
  const racketFace = new THREE.Vector3();
  const racketRight = new THREE.Vector3();
  const racketUp = new THREE.Vector3();
  const globalUp = new THREE.Vector3(0, 1, 0);
  const racketMatrix = new THREE.Matrix4();
  const viewFlip = new THREE.Quaternion().setFromAxisAngle(globalUp, Math.PI);
  // One dynamic ribbon replaces twenty transparent spheres. The full history
  // displays the real lateral curve, dipping topspin and floating backspin.
  const trailGeometry = geometry(new THREE.BufferGeometry());
  const trailPositions = new Float32Array(TRAIL_CAPACITY * 2 * 3);
  const trailColors = new Float32Array(TRAIL_CAPACITY * 2 * 4);
  const trailPositionAttribute = new THREE.BufferAttribute(trailPositions, 3).setUsage(THREE.DynamicDrawUsage);
  const trailColorAttribute = new THREE.BufferAttribute(trailColors, 4).setUsage(THREE.DynamicDrawUsage);
  trailGeometry.setAttribute('position', trailPositionAttribute);
  trailGeometry.setAttribute('color', trailColorAttribute);
  const trailIndices = [];
  for (let i = 0; i < TRAIL_CAPACITY - 1; i++) {
    const a = i * 2; trailIndices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  trailGeometry.setIndex(trailIndices); trailGeometry.setDrawRange(0, 0);
  const trailMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide }); materials.add(trailMaterial);
  const trailRibbon = mesh(trailGeometry, trailMaterial); trailRibbon.frustumCulled = false;
  const trailPoints = Array.from({ length: TRAIL_CAPACITY }, () => new THREE.Vector3());
  const trailAges = new Float32Array(TRAIL_CAPACITY);
  const trailTint = new THREE.Color();
  const trailTangent = new THREE.Vector3();
  const trailView = new THREE.Vector3();
  const trailSide = new THREE.Vector3();
  const particleGeometry = geometry(new THREE.OctahedronGeometry(0.008));
  const particleBalls = Array.from({ length: 45 }, () => {
    const m = new THREE.MeshBasicMaterial({ color: '#ffb07f', transparent: true, opacity: 0, depthWrite: false }); materials.add(m);
    const object = mesh(particleGeometry, m); object.visible = false; return object;
  });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hit = new THREE.Vector3();
  // Input intersects the visible racket face center, so grabbing it never jumps to the tabletop beneath.
  const courtPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TABLE_Y + RACKET_HEIGHT));
  let previousHeight = 0.22;
  let previousVerticalVelocity = 0;
  let ringAge = 1;
  let lastTime = 0;
  let aspect = 1;
  let spinAngle = 0;
  let lastRotatedView = false;
  let localPaddleHeight = RACKET_HEIGHT;

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(1, bounds.width); const height = Math.max(1, bounds.height);
    aspect = width / height;
    renderer.setSize(width, height, false);
    camera.aspect = aspect;
    // Keep a substantial tabletop in view, adapting the lens for narrow portrait/fullscreen layouts.
    camera.fov = 47;
    cameraBase.set(0, 2.6, 3.2);
    camera.position.copy(cameraBase); camera.lookAt(target);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const corner = new THREE.Vector3(0.7625, TABLE_Y, 1.37).project(camera);
    if (Math.abs(corner.x) > 0.84) {
      const fitted = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(47 / 2)) * Math.abs(corner.x) / 0.84);
      camera.fov = clamp(THREE.MathUtils.radToDeg(fitted), 47, 82);
      camera.updateProjectionMatrix();
    }
  }

  function pointerWorld(clientX, clientY, touchOffset = 0) {
    const bounds = canvas.getBoundingClientRect();
    // Input uses a stable plane: automatic racket height must not move the
    // hand target or inject a fictitious swipe into the next pointer event.
    courtPlane.constant = -(TABLE_Y + RACKET_HEIGHT);
    pointer.set(((clientX - bounds.left) / bounds.width) * 2 - 1, -((clientY - touchOffset - bounds.top) / bounds.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    if (raycaster.ray.intersectPlane(courtPlane, hit)) return { x: hit.x / X_SCALE + 500, y: hit.z / Z_SCALE + 400 };
    return { x: 500, y: 670 };
  }

  function render(state) {
    const { players, input, ball, ballHeight, phase, mode, elapsed, trail, particles, shake } = state;
    const rotate = mode === 'guest';
    const position = (x, y) => rotate ? world(1000 - x, 800 - y) : world(x, y);
    const dt = Math.min(0.05, Math.max(0, elapsed - lastTime)); lastTime = elapsed;
    camera.position.x = Math.sin(elapsed * 23) * shake * 0.0018;
    camera.position.y = cameraBase.y + Math.cos(elapsed * 21) * shake * 0.001;
    camera.lookAt(target);
    if (rotate !== lastRotatedView) { sphere.quaternion.premultiply(viewFlip); lastRotatedView = rotate; }
    for (let side = 0; side < 2; side++) {
      const self = rotate ? side === 1 : side === 0;
      const paddle = paddles[side];
      const localInput = rotate && self;
      const paddleState = localInput ? input : players[side];
      const p = localInput ? world(input.x, input.y) : position(players[side].x, players[side].y);
      const paddleHeight = finite(paddleState.height, RACKET_HEIGHT);
      if (self) localPaddleHeight = paddleHeight;
      paddle.group.position.set(p.x, TABLE_Y + paddleHeight, p.z);
      // Use exactly the collision plane's normal, retaining an upright handle.
      // A reversed normal describes the same plane and keeps the marked face visible.
      const n = racketNormal(paddleState, localInput ? 0 : side);
      racketFace.set(n.x, n.y, n.z);
      if (rotate && !localInput) { racketFace.x *= -1; racketFace.z *= -1; }
      if (racketFace.z < 0) racketFace.negate();
      racketFace.normalize();
      racketRight.crossVectors(globalUp, racketFace).normalize();
      if (racketRight.lengthSq() < 0.0001) racketRight.set(1, 0, 0);
      racketUp.crossVectors(racketFace, racketRight).normalize();
      racketMatrix.makeBasis(racketRight, racketUp, racketFace);
      paddle.group.quaternion.setFromRotationMatrix(racketMatrix);
      paddle.rubberMaterial.color.set(self ? '#fb7758' : '#f0dfac');
      paddle.rubberMaterial.emissive.set(self ? '#ff5b31' : '#e7d59c');
      paddle.rubberMaterial.emissiveIntensity = players[side].glow * 0.22;
      paddle.markMaterial.color.set(self ? '#ffeacb' : '#65774e');
      paddle.halo.position.set(p.x, TABLE_Y + 0.006, p.z + 0.015);
      paddle.halo.material.opacity = 0.4 + players[side].glow * 0.2;
    }
    const p = position(ball.x, ball.y);
    sphere.visible = ball.visible; ballShadow.visible = ball.visible;
    sphere.position.set(p.x, TABLE_Y + ballHeight, p.z);
    angularVelocity.set(finite(ball.spinX), finite(ball.spinY), finite(ball.spinZ));
    if (rotate) { angularVelocity.x *= -1; angularVelocity.z *= -1; }
    const angularSpeed = angularVelocity.length();
    if (angularSpeed > 0.0001) spinAxis.copy(angularVelocity).multiplyScalar(1 / angularSpeed);
    else spinAxis.copy(globalUp);
    if (phase === 'playing' && angularSpeed > 0.0001) {
      // Physical angular speed may exceed a phone display's refresh rate.
      // Slow its visual rate while preserving the actual axis and direction.
      angularStep.setFromAxisAngle(spinAxis, Math.min(24, angularSpeed * 0.12) * dt);
      sphere.quaternion.premultiply(angularStep).normalize();
      spinAngle = (spinAngle + Math.min(10, angularSpeed * 0.07) * dt) % (Math.PI * 2);
    }
    ballShadow.position.set(p.x + 0.014, TABLE_Y + 0.005, p.z + 0.018);
    const size = 0.55 + ballHeight * 1.4;
    ballShadow.scale.set(size, size, size);
    ballShadow.material.opacity = Math.max(0.15, 0.72 - ballHeight);
    const verticalVelocity = finite(ball.vh);
    const nearTable = ballHeight <= BALL_RADIUS + 0.012;
    const bouncedBetweenFrames = previousVerticalVelocity < 0 && verticalVelocity > 0 && ballHeight < 0.12;
    if (phase === 'playing' && ((previousHeight > BALL_RADIUS + 0.012 && nearTable) || bouncedBetweenFrames)) { ringAge = 0; bounceRing.position.set(p.x, TABLE_Y + 0.004, p.z); }
    previousHeight = ballHeight; previousVerticalVelocity = verticalVelocity; ringAge += dt;
    bounceMaterial.opacity = Math.max(0, 1 - ringAge * 5) * 0.55;
    bounceRing.scale.setScalar(1 + ringAge * 6);
    spinRing.visible = ball.visible && phase === 'playing' && angularSpeed > 4;
    spinRing.position.copy(sphere.position);
    ringAxisRotation.setFromUnitVectors(globalUp, spinAxis);
    ringPhaseRotation.setFromAxisAngle(globalUp, spinAngle);
    spinRing.quaternion.copy(ringAxisRotation).multiply(ringPhaseRotation);
    spinMaterial.color.set(spinColor(ball));
    spinMaterial.opacity = clamp(angularSpeed / 350 + 0.35, 0.35, 0.9);
    const historyCount = Math.min(trail.length, TRAIL_CAPACITY - 2);
    const historyStart = trail.length - historyCount;
    const pointCount = historyCount + 1;
    trailRibbon.visible = phase === 'playing' && historyCount > 0;
    for (let i = 0; i < pointCount; i++) {
      const item = i < historyCount ? trail[historyStart + i] : { ...ball, height: ballHeight, age: 0 };
      const x = rotate ? 1000 - item.x : item.x;
      const y = rotate ? 800 - item.y : item.y;
      trailPoints[i].set((x - 500) * X_SCALE, TABLE_Y + finite(item.height, ballHeight), (y - 400) * Z_SCALE);
      trailAges[i] = finite(item.age);
      trailTint.set(spinColor(Number.isFinite(item.spinX) ? item : ball));
      const alpha = Math.pow(Math.max(0, 1 - trailAges[i] / TRAIL_LIFETIME), 1.15);
      for (let edge = 0; edge < 2; edge++) {
        const colorOffset = (i * 2 + edge) * 4;
        trailColors[colorOffset] = trailTint.r; trailColors[colorOffset + 1] = trailTint.g;
        trailColors[colorOffset + 2] = trailTint.b; trailColors[colorOffset + 3] = alpha;
      }
    }
    for (let i = 0; i < pointCount; i++) {
      const point = trailPoints[i];
      trailTangent.subVectors(trailPoints[Math.min(pointCount - 1, i + 1)], trailPoints[Math.max(0, i - 1)]);
      trailView.subVectors(camera.position, point);
      trailSide.crossVectors(trailTangent, trailView).normalize();
      if (trailSide.lengthSq() < 0.0001) trailSide.set(1, 0, 0);
      const width = 0.006 + 0.005 * Math.max(0, 1 - trailAges[i] / TRAIL_LIFETIME);
      trailSide.multiplyScalar(width);
      const offset = i * 6;
      trailPositions[offset] = point.x - trailSide.x; trailPositions[offset + 1] = point.y - trailSide.y; trailPositions[offset + 2] = point.z - trailSide.z;
      trailPositions[offset + 3] = point.x + trailSide.x; trailPositions[offset + 4] = point.y + trailSide.y; trailPositions[offset + 5] = point.z + trailSide.z;
    }
    trailGeometry.setDrawRange(0, Math.max(0, pointCount - 1) * 6);
    trailPositionAttribute.needsUpdate = true; trailColorAttribute.needsUpdate = true;
    for (let i = 0; i < particleBalls.length; i++) {
      const object = particleBalls[i]; const item = particles[i]; object.visible = !!item;
      if (!item) continue;
      const point = position(item.x, item.y); const progress = item.age / item.life;
      object.position.set(point.x, TABLE_Y + 0.04 + Math.sin(progress * Math.PI) * 0.13, point.z);
      object.rotation.set(progress * 6, progress * 3, progress * 4);
      object.material.color.set(item.color); object.material.opacity = 1 - progress; object.scale.setScalar(0.6 + (1 - progress));
    }
    renderer.render(scene, camera);
  }
  resize();
  return {
    resize, pointerWorld, render,
    destroy() {
      geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose());
      renderer.dispose();
    },
  };
}
