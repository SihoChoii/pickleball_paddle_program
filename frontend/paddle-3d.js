/**
 * paddle-3d.js
 * Drop-in 3D pickleball paddle visualization for the IMU dashboard.
 * Uses Three.js r128 from CDN. No bundler required.
 *
 * Usage: call initPaddle3D('#paddle-canvas') after DOM ready.
 * Call updatePaddleIMU({ roll, pitch, yaw, x, y, z }) on each IMU poll.
 */

const THREEJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";

let THREE;
let scene, camera, renderer, paddleGroup;
let targetQuat, currentQuat;
let trailPoints = [];
let trailLine, trailGeometry;
const TRAIL_MAX = 120;

// Current "integrated" orientation from gyro (deg/s → rad/s)
let integratedRoll = 0, integratedPitch = 0, integratedYaw = 0;
let lastUpdateTime = null;
let useGyroIntegration = false;

export async function initPaddle3D(canvasSelector) {
  // Load Three.js dynamically
  await loadScript(THREEJS_CDN);
  THREE = window.THREE;

  const canvas = document.querySelector(canvasSelector);
  if (!canvas) return console.error("paddle-3d: canvas not found:", canvasSelector);

  const W = canvas.clientWidth || 480;
  const H = canvas.clientHeight || 340;

  // --- Renderer ---
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(W, H);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // --- Scene ---
  scene = new THREE.Scene();

  // Subtle dark background gradient via a large sphere
  const bgGeo = new THREE.SphereGeometry(50, 16, 16);
  const bgMat = new THREE.MeshBasicMaterial({
    color: 0x0a0e1a,
    side: THREE.BackSide,
  });
  scene.add(new THREE.Mesh(bgGeo, bgMat));

  // Grid floor
  const grid = new THREE.GridHelper(10, 20, 0x1a2540, 0x111827);
  grid.position.y = -2.2;
  scene.add(grid);

  // --- Camera ---
  camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 100);
  camera.position.set(0, 1.5, 6);
  camera.lookAt(0, 0, 0);

  // --- Lights ---
  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0x88ccff, 1.4);
  keyLight.position.set(4, 8, 5);
  keyLight.castShadow = true;
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xff6622, 0.5);
  rimLight.position.set(-5, 2, -4);
  scene.add(rimLight);

  const fillLight = new THREE.PointLight(0x22aaff, 0.6, 20);
  fillLight.position.set(0, 4, 2);
  scene.add(fillLight);

  // --- Paddle Group ---
  paddleGroup = new THREE.Group();
  buildPaddle(paddleGroup);
  scene.add(paddleGroup);

  // --- Quaternions ---
  targetQuat = new THREE.Quaternion();
  currentQuat = new THREE.Quaternion();

  // --- Motion Trail ---
  trailGeometry = new THREE.BufferGeometry();
  const trailPositions = new Float32Array(TRAIL_MAX * 3);
  trailGeometry.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeometry.setDrawRange(0, 0);
  const trailMat = new THREE.LineBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 0.55,
  });
  trailLine = new THREE.Line(trailGeometry, trailMat);
  scene.add(trailLine);

  // --- Resize ---
  const ro = new ResizeObserver(() => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  ro.observe(canvas);

  // --- Render loop ---
  animate();
}

function buildPaddle(group) {
  // --- Handle ---
  const handleGeo = new THREE.CylinderGeometry(0.085, 0.1, 1.05, 16);
  const handleMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a2e,
    roughness: 0.55,
    metalness: 0.3,
  });
  const handle = new THREE.Mesh(handleGeo, handleMat);
  handle.position.y = -1.3;
  handle.castShadow = true;
  group.add(handle);

  // Handle grip wrap (torus rings)
  for (let i = 0; i < 6; i++) {
    const gripGeo = new THREE.TorusGeometry(0.095, 0.012, 8, 24);
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x333366, roughness: 0.8 });
    const grip = new THREE.Mesh(gripGeo, gripMat);
    grip.rotation.x = Math.PI / 2;
    grip.position.y = -1.65 + i * 0.15;
    group.add(grip);
  }

  // --- Neck (taper between handle and paddle face) ---
  const neckGeo = new THREE.CylinderGeometry(0.22, 0.095, 0.28, 16);
  const neckMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.4, metalness: 0.5 });
  const neck = new THREE.Mesh(neckGeo, neckMat);
  neck.position.y = -0.68;
  neck.castShadow = true;
  group.add(neck);

  // --- Paddle Face (rounded rectangle via lathe + shape) ---
  const faceShape = new THREE.Shape();
  const fw = 0.82, fh = 1.1, fr = 0.18; // half-width, half-height, corner radius
  faceShape.moveTo(-fw + fr, -fh);
  faceShape.lineTo(fw - fr, -fh);
  faceShape.quadraticCurveTo(fw, -fh, fw, -fh + fr);
  faceShape.lineTo(fw, fh - fr);
  faceShape.quadraticCurveTo(fw, fh, fw - fr, fh);
  faceShape.lineTo(-fw + fr, fh);
  faceShape.quadraticCurveTo(-fw, fh, -fw, fh - fr);
  faceShape.lineTo(-fw, -fh + fr);
  faceShape.quadraticCurveTo(-fw, -fh, -fw + fr, -fh);

  const extSettings = {
    depth: 0.065,
    bevelEnabled: true,
    bevelThickness: 0.022,
    bevelSize: 0.018,
    bevelSegments: 4,
  };

  const faceGeo = new THREE.ExtrudeGeometry(faceShape, extSettings);
  faceGeo.center();

  // Primary face — carbon-fiber-ish dark
  const faceMat = new THREE.MeshStandardMaterial({
    color: 0x0f1923,
    roughness: 0.25,
    metalness: 0.7,
    envMapIntensity: 1,
  });
  const faceMesh = new THREE.Mesh(faceGeo, faceMat);
  faceMesh.position.y = 0.42;
  faceMesh.castShadow = true;
  group.add(faceMesh);

  // Edge band highlight
  const edgeGeo = new THREE.ExtrudeGeometry(faceShape, {
    depth: 0.072,
    bevelEnabled: true,
    bevelThickness: 0.005,
    bevelSize: 0.005,
    bevelSegments: 2,
  });
  edgeGeo.center();
  const edgeMat = new THREE.MeshStandardMaterial({
    color: 0x00c8e0,
    roughness: 0.35,
    metalness: 0.9,
    emissive: 0x006688,
    emissiveIntensity: 0.4,
  });
  // Wireframe-style edges using EdgesGeometry
  const edges = new THREE.EdgesGeometry(faceGeo, 15);
  const edgeLine = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.3 })
  );
  edgeLine.position.y = 0.42;
  group.add(edgeLine);

  // Center logo — glowing circle
  const logoGeo = new THREE.CircleGeometry(0.22, 32);
  const logoMat = new THREE.MeshStandardMaterial({
    color: 0x00aacc,
    emissive: 0x00aacc,
    emissiveIntensity: 0.6,
    roughness: 0.1,
    metalness: 0.8,
    transparent: true,
    opacity: 0.7,
  });
  const logo = new THREE.Mesh(logoGeo, logoMat);
  logo.position.set(0, 0.42, 0.06);
  group.add(logo);

  // Small cross/plus on logo
  for (let axis of ["x", "y"]) {
    const barGeo = new THREE.PlaneGeometry(axis === "x" ? 0.32 : 0.04, axis === "x" ? 0.04 : 0.32);
    const barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.set(0, 0.42, 0.065);
    group.add(bar);
  }

  // Paddle offset so rotation pivot is near handle center
  group.position.y = 0.3;
}

export function updatePaddleIMU({ roll, pitch, yaw, x, y, z }) {
  if (!paddleGroup || !THREE) return;

  const now = performance.now();

  if (useGyroIntegration) {
    // Integrate gyro (deg/s) over delta time
    if (lastUpdateTime !== null) {
      const dt = (now - lastUpdateTime) / 1000; // seconds
      integratedRoll  += (roll  * Math.PI / 180) * dt;
      integratedPitch += (pitch * Math.PI / 180) * dt;
      integratedYaw   += (yaw   * Math.PI / 180) * dt;
    }
    const euler = new THREE.Euler(integratedPitch, integratedYaw, integratedRoll, "YXZ");
    targetQuat.setFromEuler(euler);
  } else {
    // Direct accel tilt estimation (stable at rest, responsive)
    const ax = Math.max(-1, Math.min(1, x));
    const ay = Math.max(-1, Math.min(1, y));
    const az = Math.max(-1, Math.min(1, z));
    const pitchA = Math.asin(-ax);
    const rollA  = Math.atan2(ay, az);
    // Blend in yaw from gyro accumulation (no magnetometer = drift ok for demo)
    integratedYaw += (yaw * Math.PI / 180) * 0.016;
    const euler = new THREE.Euler(pitchA, integratedYaw, rollA, "YXZ");
    targetQuat.setFromEuler(euler);
  }

  lastUpdateTime = now;

  // Update trail — tip of paddle in world space
  const tip = new THREE.Vector3(0, 1.8, 0);
  tip.applyQuaternion(currentQuat);
  trailPoints.push(tip.clone());
  if (trailPoints.length > TRAIL_MAX) trailPoints.shift();

  const pos = trailGeometry.attributes.position;
  trailPoints.forEach((p, i) => {
    pos.setXYZ(i, p.x, p.y, p.z);
  });
  pos.needsUpdate = true;
  trailGeometry.setDrawRange(0, trailPoints.length);
}

function animate() {
  requestAnimationFrame(animate);

  if (currentQuat && targetQuat) {
    currentQuat.slerp(targetQuat, 0.12);
    paddleGroup.quaternion.copy(currentQuat);
  }

  // Idle slow rotation when no data is coming
  if (!lastUpdateTime || performance.now() - lastUpdateTime > 2000) {
    paddleGroup.rotation.y += 0.005;
  }

  renderer.render(scene, camera);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
