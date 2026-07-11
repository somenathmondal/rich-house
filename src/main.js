import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Accelerated raycasting (BVH) — used during grass placement so 35k
// coverage rays resolve in log-time instead of brute-force triangle tests.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pane } from 'tweakpane';
import { gsap } from 'gsap';
import './style.css';

// --- Global Core Variables ---
let scene, camera, renderer, controls;
let sunLight, sunHelper;
let waterPlane;
let introActive = false; // while true, the intro owns the camera (controls.update() skipped)
let mixers = []; // For bird animations
let birdFlights = []; // Circling flight paths for the birds
let elapsedTime = 0; // Accumulated scene time (drives flight paths)
let clock = new THREE.Clock();
let isPostProcessingEnabled = true; // SSAO + bloom + SMAA on by default

// --- Post-processing ---
let composer, ssaoPass, bloomPass;

// --- Pool water ---
let poolSurfaceMesh = null; // baked tiled pool surface, replaced by Water shader

// --- Grass ---
let grassMaterials = []; // lawn materials, tunable via the debug panel
let groundMesh = null;   // the Ground terrain mesh — grass blades sample its surface
let grassShader = null;  // wind shader handle (uTime driven from the render loop)

// --- Glass ---
// Glass materials get the HDRI as their envMap (applied per-material, NOT via
// scene.environment, so nothing else in the scene changes). envTexture may
// arrive before or after the GLB, so both sides check.
let glassMaterials = [];
let envTexture = null;
function applyEnvToGlass() {
  if (!envTexture) return;
  glassMaterials.forEach((m) => {
    m.envMap = envTexture;
    m.needsUpdate = true;
  });
}

// One shared glass material for all glazing, tuned to the reference look:
// mostly-reflective glazing (sky/trees mirrored) with the interior faintly
// visible. Alpha-blended with a HIGH opacity — reflections are scaled by
// opacity, so ~0.6 keeps them clearly visible while staying translucent.
// (Transmission-based glass rendered black on this model's panes.)
let glassSharedMat = null;
function getGlassMaterial() {
  if (glassSharedMat) return glassSharedMat;
  glassSharedMat = new THREE.MeshStandardMaterial({
    name: 'GlassShared',
    color: 0xa8b8c2,        // light cool grey — keeps reflections bright
    metalness: 0.5,         // reflection strength/tint driver
    roughness: 0.05,
    transparent: true,
    opacity: 0.6,
    envMapIntensity: 1.8,
  });
  if (envTexture) glassSharedMat.envMap = envTexture;
  glassMaterials.push(glassSharedMat);
  return glassSharedMat;
}

// --- Hotspot Coordinates & Elements ---
// Camera framings hand-captured in the scene via the debug panel's
// "Hotspot Cameras → Capture current view" tool.
const hotspots = [
  { id: 0, name: "Stairs", position: new THREE.Vector3(-1.8, 1.2, -6.5), camPos: new THREE.Vector3(1.7, 2.0, -19.9), lookAt: new THREE.Vector3(7.4, 1.7, -17.5) },
  { id: 1, name: "Right Top View", position: new THREE.Vector3(12.5, 7.5, 4.5), camPos: new THREE.Vector3(19.8, 5.4, -14.2), lookAt: new THREE.Vector3(10.2, 2.9, 3.0) },
  { id: 2, name: "Left Top View", position: new THREE.Vector3(-14, 8, 4.5), camPos: new THREE.Vector3(-16.7, 4.4, 27.5), lookAt: new THREE.Vector3(-7.3, 3.0, 9.7) },
  { id: 3, name: "Main Bedroom", position: new THREE.Vector3(-6, 4.2, -3.2), camPos: new THREE.Vector3(-21.6, 5.4, -15.6), lookAt: new THREE.Vector3(-6.0, 4.4, -3.1) },
  { id: 4, name: "Back View", position: new THREE.Vector3(0, 3, -16), camPos: new THREE.Vector3(-0.1, 3.3, -40.9), lookAt: new THREE.Vector3(-1.1, 2.1, -16.1) },
  { id: 5, name: "Top Living Room", position: new THREE.Vector3(0.5, 4.2, 1.5), camPos: new THREE.Vector3(4.1, 1.9, -3.3), lookAt: new THREE.Vector3(6.3, 0.1, 5.8) },
  { id: 6, name: "Right Pool", position: new THREE.Vector3(11, 0.4, -3), camPos: new THREE.Vector3(15.1, 1.7, 25.3), lookAt: new THREE.Vector3(-0.7, -0.4, 9.9) },
  // Default view — matches the initial camera position/target from init()
  { id: 7, name: "Default View", position: new THREE.Vector3(0, 2, 0), camPos: new THREE.Vector3(-26.6, 3.9, 33.0), lookAt: new THREE.Vector3(-0.7, -4.3, 2.9) }
];

// --- Audio Player ---
let audioListener, audioSound, audioLoader;
let isMusicPlaying = false;

// --- Sun spherical controls ---
// The sun orbits the scene at a fixed radius; elevation/azimuth (degrees)
// drive its position — matching the reference's intuitive controls.
const SUN_RADIUS = 56;
const sunAngles = { elevation: 29, azimuth: 51 }; // ≈ original (38, 27, 31)
function updateSunFromAngles() {
  const el = THREE.MathUtils.degToRad(sunAngles.elevation);
  const az = THREE.MathUtils.degToRad(sunAngles.azimuth);
  sunLight.position.set(
    SUN_RADIUS * Math.cos(el) * Math.sin(az),
    SUN_RADIUS * Math.sin(el),
    SUN_RADIUS * Math.cos(el) * Math.cos(az)
  );
  if (waterPlane) waterPlane.material.uniforms['sunDirection'].value.copy(sunLight.position).normalize();
  syncSunUI();
}

// Keep the drawer UI (sliders, track fills, serif degree readouts) in lockstep
// with the sun state — including while presets animate the angles via GSAP.
function syncSunUI() {
  const elSlider = document.getElementById('elevation');
  const azSlider = document.getElementById('azimuth');
  const elValue = document.getElementById('elevation-value');
  const azValue = document.getElementById('azimuth-value');

  if (elSlider) {
    elSlider.value = sunAngles.elevation;
    const pct = ((sunAngles.elevation - 2) / (88 - 2)) * 100;
    elSlider.style.setProperty('--fill', `${pct.toFixed(1)}%`);
  }
  if (azSlider) {
    azSlider.value = sunAngles.azimuth;
    azSlider.style.setProperty('--fill', `${((sunAngles.azimuth / 360) * 100).toFixed(1)}%`);
  }
  if (elValue) elValue.textContent = Math.round(sunAngles.elevation);
  if (azValue) azValue.textContent = Math.round(sunAngles.azimuth);
}

// --- Analytics ---
// Thin wrapper over gtag: no-ops if GA is blocked/unavailable.
function track(eventName, params = {}) {
  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
  }
}

// --- Initialize Loading Manager ---
const loadingManager = new THREE.LoadingManager();
const loaderBar = document.getElementById('loadingBar');
const loaderText = document.getElementById('loaderText');
const loaderSun = document.getElementById('loaderSun');
const loaderPercent = document.getElementById('loaderPercent');
const loaderOverlay = document.getElementById('loaderOverlay');
const continueBtn = document.getElementById('btn-continue-explore');

loadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
  const progress = Math.round((itemsLoaded / itemsTotal) * 100);
  if (loaderBar) loaderBar.style.width = `${progress}%`;
  if (loaderSun) loaderSun.style.left = `${progress}%`;   // the sun rises along the horizon
  if (loaderPercent) loaderPercent.textContent = progress;
};

loadingManager.onLoad = () => {
  // performance.now() is ms since navigation start = total time to all assets
  console.warn(`[load] all assets loaded in ${(performance.now() / 1000).toFixed(2)}s`);
  if (loaderText) loaderText.innerText = "Ready";
  // Skip the "Explore Scene" gate — reveal the 3D scene automatically.
  revealScene();
};

// Fade out the loading overlay and reveal the scene. Used on auto-load and
// kept wired to the button as a manual fallback.
function revealScene() {
  if (!loaderOverlay || loaderOverlay.dataset.revealed === 'true') return;
  loaderOverlay.dataset.revealed = 'true';

  // Cinematic intro: rotate from the Back View around the house to the
  // Default View — a ~138° orbital sweep about the default look-at pivot.
  // Controls stay locked until it lands.
  controls.enabled = false;
  introActive = true; // stop controls.update() from stomping the intro camera
  const defaultPt = hotspots.find((h) => h.name === 'Default View');
  const backPt = hotspots.find((h) => h.name === 'Back View');
  const pivot = defaultPt.lookAt.clone();

  const endSph = new THREE.Spherical().setFromVector3(defaultPt.camPos.clone().sub(pivot));
  const sph = new THREE.Spherical().setFromVector3(backPt.camPos.clone().sub(pivot));
  // Take the short way around the house
  const dTheta = endSph.theta - sph.theta;
  if (dTheta > Math.PI) sph.theta += Math.PI * 2;
  else if (dTheta < -Math.PI) sph.theta -= Math.PI * 2;

  // The look-at eases from Back View's own target to the default pivot, so
  // the first frame matches the Back View button's framing exactly and the
  // last frame matches the Default View exactly.
  const lookProgress = { t: 0 };
  const lookPoint = new THREE.Vector3();
  const applyIntroCam = () => {
    camera.position.setFromSpherical(sph).add(pivot);
    lookPoint.lerpVectors(backPt.lookAt, pivot, lookProgress.t);
    camera.lookAt(lookPoint);
  };
  applyIntroCam();
  // Hold the Back View for a beat, then rotate slowly around to the default.
  gsap.to(lookProgress, { t: 1, duration: 7.0, delay: 2.0, ease: 'power2.inOut' });
  gsap.to(sph, {
    radius: endSph.radius,
    phi: endSph.phi,
    theta: endSph.theta,
    duration: 7.0,
    delay: 2.0,
    ease: 'power2.inOut',
    onUpdate: applyIntroCam,
    onComplete: () => {
      introActive = false;
      controls.enabled = true;
    }
  });

  gsap.to(loaderOverlay, {
    opacity: 0,
    duration: 1.0,
    onComplete: () => {
      loaderOverlay.style.display = 'none';

      // Fade in main logo title splash (timed to land late in the sweep)
      gsap.fromTo('#section-logo', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 1.4, delay: 5.5 });

      // Try to start ambient music. Browsers keep the AudioContext suspended
      // until a user gesture, so it may stay silent until the first click.
      if (audioSound && audioSound.buffer && !isMusicPlaying) {
        try {
          audioSound.play();
          isMusicPlaying = true;
          const btn = document.getElementById('music-btn');
          if (btn) btn.classList.remove('muted');
        } catch (e) { /* autoplay blocked; music button is the fallback */ }
      }

      // Resume audio on first user interaction (autoplay-policy safe).
      const resumeAudio = () => {
        const ctx = audioListener && audioListener.context;
        if (ctx && ctx.state === 'suspended') ctx.resume();
        window.removeEventListener('pointerdown', resumeAudio);
      };
      window.addEventListener('pointerdown', resumeAudio);
    }
  });
}

// --- Scene Initialization ---
function init() {
  const container = document.getElementById('canvas-container');

  // 1. Create Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a111e, 0.007);

  // 2. Camera Setup
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.set(-26.6, 3.9, 33.0); // Default View (captured)

  // 3. Renderer Setup
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  container.appendChild(renderer.domElement);

  // 4. Orbit Controls Setup
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 - 0.05; // Prevent camera going below ground
  controls.minDistance = 3;
  controls.maxDistance = 80;
  controls.target.set(-0.7, -4.3, 2.9); // Default View look-at (captured)

  // 5. Audio Setup
  audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  audioSound = new THREE.Audio(audioListener);
  audioLoader = new THREE.AudioLoader(loadingManager);
  
  audioLoader.load('sounds/music_loop.mp3', (buffer) => {
    audioSound.setBuffer(buffer);
    audioSound.setLoop(true);
    audioSound.setVolume(0.4);
  });

  // 6. Lights & Environment Setup
  setupLights();
  setupEnvironment();

  // 6b. Post-processing composer (SSAO + bloom), off until toggled
  setupPostProcessing();

  // 7. Load Models
  loadGLTFModels();

  // 8. Setup Hotspot Click Handlers
  setupHotspots();

  // 9. Bind UI Events
  bindUIEvents();

  // 9b. Debug panel (Tweakpane) for live tuning
  setupDebugPanel();

  // 10. Start Render/Animation Loop
  window.addEventListener('resize', onWindowResize, false);
  
  // Expose WebGL handles to window for runtime inspection
  window.scene = scene;
  window.renderer = renderer;
  window.houseMesh = houseMesh;

  animate();
}

// --- Setup Lights ---
function setupLights() {
  // Ambient light for general soft illumination
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);

  // Hemisphere light to simulate sky dome and ground bounce lighting (prevents pitch-black shadows)
  const hemiLight = new THREE.HemisphereLight(0xfff5ea, 0x1a2430, 1.5);
  scene.add(hemiLight);

  // Sun Light (Directional) — warm golden key to match the reference's
  // sunlit concrete. (Only the sun is changed here; ambient/hemi untouched.)
  sunLight = new THREE.DirectionalLight(0xffcf8a, 7.2); // warm gold, brighter
  sunLight.position.set(38, 27, 31); // Default sunset position
  sunLight.castShadow = true;
  
  // Shadow quality optimization — higher res + tighter frustum keeps the
  // shadow edges crisp (fixes the jagged sawtooth along the pool rim).
  sunLight.shadow.mapSize.width = 4096;
  sunLight.shadow.mapSize.height = 4096;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 150;

  const d = 32;
  sunLight.shadow.camera.left = -d;
  sunLight.shadow.camera.right = d;
  sunLight.shadow.camera.top = d;
  sunLight.shadow.camera.bottom = -d;
  // Fix shadow acne (the striped self-shadowing on the flat roofs).
  // normalBias offsets the shadow sample along the surface normal, which is
  // the right tool for large flat faces; keep bias tiny to avoid peter-panning.
  sunLight.shadow.bias = -0.0001;
  sunLight.shadow.normalBias = 0.06;

  scene.add(sunLight);

  // Lens flare on the sun (subtle — used judiciously).
  setupLensflare();
}

// --- Lens flare attached to the sun ---
// Recipe matched to the reference: a huge warm atmospheric glow on the sun
// plus large chromatic rainbow ghosts marching along the axis past screen
// centre (distance 1.0 = centre, >1 continues to the opposite quadrant).
let flareGlow = null;
let flareGhosts = [];

// Soft radial glow texture (white core fading to black). lensflare1.jpg is a
// hard-edged flat disc — at large sizes it rendered as a giant sharp circle.
// A canvas gradient fades to black, so the additive blend melts into the sky.
function makeGlowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, '#ffffff');
  g.addColorStop(0.15, '#bbbbbb');
  g.addColorStop(0.4, '#444444');
  g.addColorStop(0.7, '#141414');
  g.addColorStop(1.0, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function setupLensflare() {
  const loader = new THREE.TextureLoader(loadingManager);
  const glowTex = makeGlowTexture();                         // soft warm glow
  const ringTex = loader.load('textures/lensflare3.jpg');   // rainbow halo ring
  const burstTex = loader.load('textures/lensflare22.jpeg'); // chromatic arc pair

  const lensflare = new Lensflare();

  // Big golden glow sitting on the sun itself — deep amber and oversized so
  // it reads as atmospheric sunset haze, not a pale disc.
  const warm = new THREE.Color(1.0, 0.58, 0.22);
  flareGlow = new LensflareElement(glowTex, 1400, 0, warm);
  lensflare.addElement(flareGlow);

  // Rainbow ghosts along the flare axis — compact chromatic arcs lead,
  // rings kept small/subtle (big ring outlines dominated too much).
  flareGhosts = [
    new LensflareElement(burstTex, 280, 0.45),
    new LensflareElement(ringTex, 140, 0.65),
    new LensflareElement(burstTex, 420, 0.9),
    new LensflareElement(burstTex, 240, 1.15),
    new LensflareElement(ringTex, 110, 1.35),
    new LensflareElement(burstTex, 320, 1.6)
  ];
  flareGhosts.forEach((g) => lensflare.addElement(g));
  flareGhosts.forEach((g) => { g.userData_baseSize = g.size; });

  // Attach to the sun so the flare tracks the light position.
  sunLight.add(lensflare);
}

// --- Setup Environment Map (EXR) ---
function setupEnvironment() {
  const exrLoader = new EXRLoader(loadingManager);
  // Request Float32 data so we can sanitize the pixel values below.
  exrLoader.setDataType(THREE.FloatType);

  exrLoader.load('textures/spruit_sunrise_1K.exr', (texture) => {
    // Sanitize: HDR sun texels with Inf/NaN (or absurd radiance) poison the
    // IBL convolution and turn every lit surface black. Clamp them.
    const data = texture.image && texture.image.data;
    if (data && data.length) {
      const MAX = 64;
      let bad = 0, hot = 0, peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (!Number.isFinite(v)) { data[i] = MAX; bad++; }
        else if (v > MAX) { data[i] = MAX; hot++; if (v > peak) peak = v; }
        else if (v > peak) peak = v;
      }
      texture.needsUpdate = true;
      console.warn(`[env] EXR sanitized — non-finite: ${bad}, clamped>${MAX}: ${hot}, peak seen: ${peak.toFixed(1)}`);
    }

    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;

    // Use the equirect EXR directly as the environment — three.js converts
    // it internally (no manual PMREM, which was producing a corrupted env
    // texture and blacking out every surface that sampled it).
    envTexture = texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.5;
    applyEnvToGlass();

    console.warn(`[glass] envTexture ready; glass materials registered: ${glassMaterials.length}`);
    console.log("EXR Environment loaded as background successfully!");
  });
}

// --- Setup Post-Processing (SSAO ambient occlusion + subtle bloom) ---
function setupPostProcessing() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  composer.setSize(w, h);

  // Base scene render
  composer.addPass(new RenderPass(scene, camera));

  // SSAO — grounds the building with contact ambient occlusion in the
  // crevices where volumes meet. Kept subtle so it darkens creases, not walls.
  ssaoPass = new SSAOPass(scene, camera, w, h);
  ssaoPass.kernelRadius = 8;
  ssaoPass.minDistance = 0.002;
  ssaoPass.maxDistance = 0.08;
  composer.addPass(ssaoPass);

  // Subtle bloom — only the brightest highlights (sun glints, sky) glow.
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.10, 0.4, 0.9);
  composer.addPass(bloomPass);

  // OutputPass applies tone mapping + output color space near the end.
  composer.addPass(new OutputPass());

  // SMAA anti-aliasing — the composer bypasses the renderer's built-in MSAA,
  // so without this the edges get jagged once post-processing is on. Runs
  // last, on the final resolved image.
  const pr = Math.min(window.devicePixelRatio, 1.5);
  composer.addPass(new SMAAPass(w * pr, h * pr));
}

// --- Load GLTF Models ---
let houseMesh = null;
function loadGLTFModels() {
  const gltfLoader = new GLTFLoader(loadingManager);
  
  // Setup DRACOLoader for decompressed mesh loads
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  gltfLoader.setDRACOLoader(dracoLoader);

  // Load Seashore House
  gltfLoader.load('models/beach-house.glb', (gltf) => {
    houseMesh = gltf.scene;
    
    // Enable Shadows for all mesh instances
    houseMesh.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        

        // Glass: swap to the shared physical (transmission) glass so it
        // reflects the sky at full fresnel strength while staying see-through.
        if (child.name.toLowerCase().includes('glass') || (child.material && child.material.name && child.material.name.toLowerCase().includes('glass'))) {
          child.material = getGlassMaterial();
          child.castShadow = false; // glazing shouldn't cast solid shadows
        }

        const matName = (child.material && child.material.name ? child.material.name : '').toLowerCase();

        // Add procedural surface relief to concrete walls and floor/roof slabs
        // so they're not flat like plastic (skip glass, handled above).
        const isWallOrFloor = ['branco', 'concrete', 'externalwalls', '1stfloo']
          .some(k => matName.includes(k));
        if (isWallOrFloor && !matName.includes('glass')) {
          applyWallNormal(child.material, 4, 0.4);
        }

        // Grass: lift the lawn out of the dark baked hunter-green toward a
        // livelier natural lawn (exact match = the Ground plane only).
        if (matName === 'grass') {
          child.material.color = new THREE.Color(0x5d8046);
          child.material.roughness = 1.0;
          child.material.envMapIntensity = 0.4; // keep the lawn matte
          child.material.needsUpdate = true;
          grassMaterials.push(child.material);
          groundMesh = child; // blades are scattered across this surface
        }


        // Water fix: capture the baked tiled-cyan pool surface so we can hide
        // it and replace it with a real reflective Water shader (like the
        // reference). Targets ONLY the tiled-water material by exact name.
        if (matName === 'poolfloor') {
          poolSurfaceMesh = child;
          console.warn(`[water] found pool surface mesh "${child.name}"`);
        }
      }
    });

    scene.add(houseMesh);
    applyEnvToGlass(); // in case the EXR finished before the GLB
    console.warn(`[glass] GLB traversed; glass materials registered: ${glassMaterials.length}; envMap set: ${!!(glassSharedMat && glassSharedMat.envMap)}`);
    console.log("Seashore House GLTF Loaded!");
    
    // Setup water plane after house model loads (aligning to pool location)
    setupWater();

    // Scatter wind-swayed grass blades across the lawn (needs groundMesh)
    setupGrass();
  });

  // Load animated Seagull birds — small, high, and circling slowly so they
  // read as a distant flock rather than large birds hovering over the roof.
  gltfLoader.load('models/bird.glb', (gltf) => {
    const birdModel = gltf.scene;

    // Per-bird flight path parameters (circle radius/height/speed/phase)
    const flights = [
      { scale: 0.06, radius: 34, height: 22, speed: 0.10, phase: 0.0 },
      { scale: 0.08, radius: 42, height: 26, speed: 0.07, phase: 2.1 },
      { scale: 0.05, radius: 28, height: 19, speed: 0.12, phase: 4.2 }
    ];

    flights.forEach((f, index) => {
      const birdClone = birdModel.clone();
      birdClone.scale.set(f.scale, f.scale, f.scale);
      scene.add(birdClone);
      birdFlights.push({ obj: birdClone, ...f });

      // Setup Animation Mixer
      if (gltf.animations.length > 0) {
        const mixer = new THREE.AnimationMixer(birdClone);
        const action = mixer.clipAction(gltf.animations[0]);
        action.play();

        // Offset starting times
        action.time = index * 0.5;
        mixers.push(mixer);
      }
    });
    console.log("Birds loaded & animation clip bounds playing.");
  });
}

// --- Tile/plaster normal map for walls & floors ---
// Loads the real wallTexture2 normal map once and shares it across the
// concrete surfaces so they get plaster/tile surface relief.
let _wallNormalBase = null;
const wallMaterials = []; // tracked so the debug panel can retune them live
function getWallNormalBase() {
  if (_wallNormalBase) return _wallNormalBase;
  const loader = new THREE.TextureLoader(loadingManager);
  _wallNormalBase = loader.load('textures/wallTexture2.jpg');
  _wallNormalBase.wrapS = _wallNormalBase.wrapT = THREE.RepeatWrapping;
  _wallNormalBase.colorSpace = THREE.NoColorSpace; // normal maps are linear data
  _wallNormalBase.repeat.set(20, 20);
  return _wallNormalBase;
}

// Assign the shared wall normal map to a material.
function applyWallNormal(material, repeat = 20, scale = 1.0) {
  const tex = getWallNormalBase();
  tex.repeat.set(repeat, repeat);
  material.normalMap = tex;
  material.normalScale = new THREE.Vector2(scale, scale);
  material.needsUpdate = true;
  if (!wallMaterials.includes(material)) wallMaterials.push(material);
}

// --- Procedural Ghibli Grass (ported from the feed-panda project) ---
// Instanced grass blades scattered over the Ground mesh surface, with a
// custom wind shader: travelling gusts, per-blade turbulence and flutter,
// two-tone colour gradients broken up by noise patches, translucent
// backlight and a fresnel rim.
function setupGrass() {
  if (!groundMesh) {
    console.warn('[grass] no Ground mesh found — skipping blade scatter');
    return;
  }

  const noiseMap = new THREE.TextureLoader(loadingManager).load('textures/perlin.webp');
  noiseMap.wrapS = THREE.RepeatWrapping;
  noiseMap.wrapT = THREE.RepeatWrapping;

  const grassLoader = new GLTFLoader(loadingManager);
  grassLoader.load('models/grass-blades-up.glb', (gltf) => {
    let grassGeo = null;
    gltf.scene.traverse((child) => {
      if (child.isMesh && !grassGeo) grassGeo = child.geometry;
    });
    if (!grassGeo) {
      console.error('[grass] could not find geometry in grass GLB');
      return;
    }

    const bBox = new THREE.Box3().setFromObject(gltf.scene);
    const bSize = new THREE.Vector3();
    bBox.getSize(bSize);
    const bladeHeight = bSize.y || 0.35;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;
    const GRASS_COUNT = isMobile ? 15000 : 35000;
    const BLADE_SCALE = 0.5; // rich-house world units are larger than feed-panda's

    const grassMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
      metalness: 0.0,
      side: THREE.DoubleSide,
      transparent: true, // translucent Ghibli look
      opacity: 0.85
    });

    grassMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.uniforms.uNoiseMap = { value: noiseMap };
      shader.uniforms.uWindStrength = { value: 0.25 };
      shader.uniforms.uWindSpeed = { value: 2.0 };
      shader.uniforms.uWindAngle = { value: 45.0 };
      shader.uniforms.uGustScale = { value: 0.5 };
      shader.uniforms.uTurbulence = { value: 0.28 };
      shader.uniforms.uFlutter = { value: 0.28 };
      shader.uniforms.uHeightVariation = { value: 0.5 };
      shader.uniforms.uHeightNoiseScale = { value: 0.15 };
      shader.uniforms.uRootColor = { value: new THREE.Color('#325222') };
      shader.uniforms.uTipColor = { value: new THREE.Color('#7eb529') };
      shader.uniforms.uRootColorB = { value: new THREE.Color('#5d8046') };
      shader.uniforms.uTipColorB = { value: new THREE.Color('#c8cf56') };
      shader.uniforms.uColorVariation = { value: 0.5 };
      shader.uniforms.uColorPatchScale = { value: 0.7 };
      shader.uniforms.uMacroVariation = { value: 0.48 };
      shader.uniforms.uMacroScale = { value: 0.115 };
      shader.uniforms.uBladeHeight = { value: bladeHeight };

      grassMat.userData.shader = shader;
      grassShader = shader;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorldPosition;
         varying float vHeightAlongBlade;
         varying float vInstanceSeed;

         uniform float uTime;
         uniform sampler2D uNoiseMap;
         uniform float uWindStrength;
         uniform float uWindSpeed;
         uniform float uWindAngle;
         uniform float uGustScale;
         uniform float uTurbulence;
         uniform float uFlutter;
         uniform float uHeightVariation;
         uniform float uHeightNoiseScale;
         uniform float uBladeHeight;

         attribute vec2 aOrigin;
         attribute vec2 aFacing;

         float hash(float n) {
             return fract(sin(n) * 43758.5453123);
         }
         float hash(vec2 p) {
             return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
         }

         vec3 getWindSway(vec3 localPos, vec2 origin, vec2 facing, float timeVal, float index) {
             float height = uBladeHeight;
             float t = clamp(localPos.y / height, 0.0, 1.0);

             float bladeSeed = hash(index);
             float bladePhase = bladeSeed * 6.2831853;
             float ampVar = 0.65 + hash(index + 7.0) * 0.7;

             float baseAngle = uWindAngle * (3.14159265 / 180.0);
             float wobble = sin(timeVal * uWindSpeed * 0.6 + bladePhase) * uTurbulence * 0.4;
             float angle = baseAngle + wobble;
             vec2 windDir = vec2(cos(angle), sin(angle));
             vec2 perpDir = vec2(-windDir.y, windDir.x);

             float along = dot(origin, windDir);

             vec2 noiseUV = origin * 0.03;
             float noiseVal = texture2D(uNoiseMap, noiseUV).r;
             float noiseJitter = (noiseVal - 0.5) * 2.0;

             float gustPhase = along * uGustScale - timeVal * uWindSpeed * 0.6 + noiseJitter * 1.5;
             float gust = pow(sin(gustPhase) * 0.5 + 0.5, 1.6);

             float chopPhase = along * (uGustScale * 2.7) - timeVal * uWindSpeed * 1.3 + bladePhase;
             float chop = sin(chopPhase) * 0.5 + 0.5;

             float intensity = (0.25 + gust * 0.85 + chop * 0.18) * ampVar;

             float BEND_GAIN = 3.0;
             float phi = clamp(uWindStrength * intensity * BEND_GAIN, 0.0, 1.6);

             float bendExponent = 1.5;
             float shaped = pow(t, bendExponent);
             float a = phi * shaped;
             float safePhi = max(phi, 0.001);
             float R = height / safePhi;
             float u = R * (1.0 - cos(a));
             float dv = R * sin(a) - localPos.y;

             float flutterMask = smoothstep(0.55, 1.0, t);
             float flutterPhase = timeVal * 10.0 + bladeSeed * 3.0 + along * 0.8;
             float flutterAmt = sin(flutterPhase) * uFlutter * 0.08 * flutterMask;

             vec2 horiz = windDir * u + perpDir * flutterAmt;

             float cosY = facing.x;
             float sinY = facing.y;
             float localX = horiz.x * cosY - horiz.y * sinY;
             float localZ = horiz.x * sinY + horiz.y * cosY;

             return vec3(localX, dv, localZ);
         }
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         float instanceIdx = float(gl_InstanceID);
         vec3 sway = getWindSway(position, aOrigin, aFacing, uTime, instanceIdx);

         float hNoise = hash(aOrigin + vec2(53.0, 17.0));
         float hFactor = clamp(1.0 + (hNoise - 0.5) * 2.0 * uHeightVariation, 0.2, 1.8);

         vec3 swayed = position + sway;
         transformed = vec3(swayed.x, swayed.y * hFactor, swayed.z);
         vInstanceSeed = hash(instanceIdx + 13.37);
        `
      );

      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         #ifdef USE_INSTANCING
             vWorldPosition = ( instanceMatrix * vec4( swayed, 1.0 ) ).xyz;
             vWorldPosition.y *= hFactor;
             vWorldPosition = ( modelMatrix * vec4( vWorldPosition, 1.0 ) ).xyz;
         #else
             vWorldPosition = ( modelMatrix * vec4( swayed, 1.0 ) ).xyz;
             vWorldPosition.y *= hFactor;
         #endif
         vHeightAlongBlade = clamp(position.y / uBladeHeight, 0.0, 1.0);
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
         varying vec3 vWorldPosition;
         varying float vHeightAlongBlade;
         varying float vInstanceSeed;

         uniform float uTime;
         uniform sampler2D uNoiseMap;
         uniform vec3 uRootColor;
         uniform vec3 uTipColor;
         uniform vec3 uRootColorB;
         uniform vec3 uTipColorB;
         uniform float uColorVariation;
         uniform float uColorPatchScale;
         uniform float uMacroVariation;
         uniform float uMacroScale;
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         vec3 skyNormalWorld = (vec4(normal, 0.0) * viewMatrix).xyz;
         skyNormalWorld = normalize(vec3(skyNormalWorld.x, abs(skyNormalWorld.y), skyNormalWorld.z));
         normal = normalize( ( viewMatrix * vec4(skyNormalWorld, 0.0) ).xyz );
         #ifdef DOUBLE_SIDED
             normal = normal * ( float( gl_FrontFacing ) * 2.0 - 1.0 );
         #endif
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         float gradT = pow(vHeightAlongBlade, 1.4);
         vec3 gradientA = mix(uRootColor, uTipColor, gradT);
         vec3 gradientB = mix(uRootColorB, uTipColorB, gradT);

         vec2 patchUV = vWorldPosition.xz * uColorPatchScale * 0.25;
         float patchNoise = texture2D(uNoiseMap, patchUV).r;
         float patchBlend = clamp(patchNoise * uColorVariation, 0.0, 1.0);
         vec3 baseColor = mix(gradientA, gradientB, patchBlend);

         vec2 macroUV = (vWorldPosition.xz + vec2(137.0, 91.0)) * uMacroScale * 0.15;
         float macroNoise = texture2D(uNoiseMap, macroUV).r;
         float macroFactor = 1.0 + (macroNoise - 0.5) * 2.0 * uMacroVariation;

         float brightness = mix(0.85, 1.15, vInstanceSeed);
         vec3 finalColor = baseColor * macroFactor * brightness;
         diffuseColor = vec4( finalColor, opacity );
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         vec3 sunDir = vec3(0.4243, 0.7071, 0.5657); // World-space sun direction
         vec3 viewDir = normalize(cameraPosition - vWorldPosition);

         float transDistortion = 0.5;
         vec3 transLightDir = normalize(sunDir + skyNormalWorld * transDistortion);
         float backLight = pow(max(dot(viewDir, -transLightDir), 0.0), 3.0);
         float thicknessMask = pow(vHeightAlongBlade, 1.5);
         vec3 translucencyColor = vec3(207.0/255.0, 224.0/255.0, 106.0/255.0);
         vec3 translucency = translucencyColor * backLight * thicknessMask * 1.2;

         float fresnelVal = pow(1.0 - max(dot(skyNormalWorld, viewDir), 0.0), 4.0);
         vec3 fresnelColor = vec3(234.0/255.0, 242.0/255.0, 192.0/255.0);
         vec3 fresnelRim = fresnelColor * fresnelVal * 0.25;

         totalEmissiveRadiance += (translucency + fresnelRim);
        `
      );
    };

    // --- Scatter blades across the actual Ground surface ---
    // MeshSurfaceSampler picks points on the lawn geometry itself, so the
    // pool cut-out, deck and slopes are respected automatically.
    groundMesh.updateWorldMatrix(true, false);
    const sampler = new MeshSurfaceSampler(groundMesh).build();
    const samplePos = new THREE.Vector3();

    // Reject samples hidden under anything sitting on the lawn (stepping
    // tiles, rocks, deck, statues…): collect every mesh whose bounds overlap
    // the lawn near ground level, then cast a short ray straight up from
    // each sampled point — a hit means no blade there.
    houseMesh.updateWorldMatrix(true, true);
    const groundBox = new THREE.Box3().setFromObject(groundMesh);
    const obstacles = [];
    houseMesh.traverse((c) => {
      if (!c.isMesh || c === groundMesh) return;
      const n = c.name.toLowerCase();
      if (n.startsWith('plane034') || n.startsWith('tree')) return; // tufts/trees are fine
      const b = new THREE.Box3().setFromObject(c);
      if (!b.intersectsBox(groundBox)) return;      // nowhere near the lawn
      if (b.min.y > groundBox.max.y + 1.0) return;  // floats high above it (roof slabs)
      obstacles.push(c);
    });
    console.warn(`[grass] blade-blocking obstacles: ${obstacles.map((o) => o.name || o.type).join(', ')}`);

    // Precompute obstacle bounds once — the placement loop only raycasts
    // against obstacles whose box actually contains the sample point, which
    // keeps 35k-sample placement fast instead of blocking the loader.
    const obstacleBoxes = obstacles.map((o) => new THREE.Box3().setFromObject(o));

    // Build BVHs so each coverage ray is a log-time lookup (one-time cost).
    const tBvh = performance.now();
    obstacles.forEach((o) => {
      if (o.geometry && !o.geometry.boundsTree) o.geometry.computeBoundsTree();
    });
    console.warn(`[grass] BVH build: ${(performance.now() - tBvh).toFixed(0)}ms for ${obstacles.length} obstacles`);

    // The pool-rim wall top is a thin strip at water height along the water's
    // bounding-box edge (where the stairs meet the pool) — blades there read
    // as growing out of the coping. Cull a narrow band around that edge, at
    // water height only, so lawns above/below the pool level are untouched.
    const waterBox = waterPlane ? new THREE.Box3().setFromObject(waterPlane) : null;
    const RIM = 1.2;
    function onPoolRim(pos) {
      if (!waterBox) return false;
      // Pool-level band: from deep enough that a tall blade could still poke
      // above the water (~1.8 below) up to just above the coping.
      if (pos.y < waterBox.max.y - 1.8 || pos.y > waterBox.max.y + 1.0) return false;
      const inOuter =
        pos.x > waterBox.min.x - RIM && pos.x < waterBox.max.x + RIM &&
        pos.z > waterBox.min.z - RIM && pos.z < waterBox.max.z + RIM;
      const inInner =
        pos.x > waterBox.min.x + RIM && pos.x < waterBox.max.x - RIM &&
        pos.z > waterBox.min.z + RIM && pos.z < waterBox.max.z - RIM;
      return inOuter && !inInner; // in the edge band only
    }

    const upRay = new THREE.Raycaster();
    upRay.far = 12;
    const UP = new THREE.Vector3(0, 1, 0);
    const rayOrigin = new THREE.Vector3();
    const candidates = [];
    function isCovered(pos) {
      // Water first — pure math, no ray: under the water rectangle = covered.
      if (waterBox &&
          pos.y < waterBox.max.y &&
          pos.x > waterBox.min.x && pos.x < waterBox.max.x &&
          pos.z > waterBox.min.z && pos.z < waterBox.max.z) {
        return true;
      }

      // Only raycast obstacles whose bounding box contains this point.
      candidates.length = 0;
      for (let k = 0; k < obstacles.length; k++) {
        const b = obstacleBoxes[k];
        if (pos.x >= b.min.x && pos.x <= b.max.x &&
            pos.z >= b.min.z && pos.z <= b.max.z &&
            b.max.y > pos.y) {
          candidates.push(obstacles[k]);
        }
      }
      if (!candidates.length) return false;

      rayOrigin.set(pos.x, pos.y + 0.03, pos.z);
      upRay.set(rayOrigin, UP);
      return upRay.intersectObjects(candidates, false).length > 0;
    }

    const originArray = new Float32Array(GRASS_COUNT * 2);
    const facingArray = new Float32Array(GRASS_COUNT * 2);
    const dummy = new THREE.Object3D();

    let _seed = 12345;
    function seededRandom() {
      _seed = (_seed * 16807) % 2147483647;
      return (_seed - 1) / 2147483646;
    }

    const instancedGrass = new THREE.InstancedMesh(grassGeo, grassMat, GRASS_COUNT);
    instancedGrass.receiveShadow = true;

    const tPlace = performance.now();
    for (let i = 0; i < GRASS_COUNT; i++) {
      // Resample if the point is hidden under a walkway tile (bounded tries)
      let tries = 0;
      do {
        sampler.sample(samplePos);
        samplePos.applyMatrix4(groundMesh.matrixWorld); // local → world
      } while ((isCovered(samplePos) || onPoolRim(samplePos)) && ++tries < 8);
      if (tries >= 8) { // give up on this blade — collapse it to nothing
        dummy.position.set(0, -100, 0);
        dummy.scale.setScalar(0.0001);
        dummy.updateMatrix();
        instancedGrass.setMatrixAt(i, dummy.matrix);
        continue;
      }

      dummy.position.copy(samplePos);

      const angleY = seededRandom() * Math.PI * 2;
      const bendX = (seededRandom() - 0.5) * 0.1;
      const bendZ = (seededRandom() - 0.5) * 0.1;
      dummy.rotation.set(bendX, angleY, bendZ);

      const w = (0.8 + seededRandom() * 0.4) * BLADE_SCALE;
      const h = (0.8 + seededRandom() * 0.5) * BLADE_SCALE;
      dummy.scale.set(w, h, w);
      dummy.updateMatrix();
      instancedGrass.setMatrixAt(i, dummy.matrix);

      originArray[i * 2 + 0] = samplePos.x;
      originArray[i * 2 + 1] = samplePos.z;
      facingArray[i * 2 + 0] = Math.cos(angleY);
      facingArray[i * 2 + 1] = Math.sin(angleY);
    }

    grassGeo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(originArray, 2));
    grassGeo.setAttribute('aFacing', new THREE.InstancedBufferAttribute(facingArray, 2));

    window._grassMaterial = grassMat;
    window._grassMesh = instancedGrass;
    scene.add(instancedGrass);
    console.warn(`[grass] ${GRASS_COUNT} blades scattered in ${(performance.now() - tPlace).toFixed(0)}ms (blade height ${bladeHeight.toFixed(2)})`);
  }, undefined, (err) => {
    console.error('[grass] blade GLB load FAILED:', err);
  });
}

// --- Setup Real-Time Water Shader ---
// Replaces the baked tiled-cyan pool surface with a reflective Water shader
// sized to the pool's real world bounds (like the reference site).
function setupWater() {
  const textureLoader = new THREE.TextureLoader(loadingManager);

  // Default footprint if we couldn't find the pool mesh.
  let sizeX = 34, sizeZ = 26;
  let poolPosition = new THREE.Vector3(5, 0.4, 0);

  if (poolSurfaceMesh) {
    // World-space bounding box of the baked pool surface.
    const box = new THREE.Box3().setFromObject(poolSurfaceMesh);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    sizeX = size.x;
    sizeZ = size.z;
    // Sit the water surface a little below the top of the pool basin so the
    // concrete lip rises above the waterline (like a real pool).
    const WATER_DROP = 0.47; // lower = water sits deeper in the basin
    poolPosition.set(center.x, box.max.y - WATER_DROP, center.z);

    // (The GLB already has its own pool wall — it just looked black before the
    // shadow-bias fix — so we don't add a custom coping.)

    // The pool wall + basin + water surface are one merged mesh, so we can't
    // hide it (that removes the wall). Instead strip the cyan tile and repaint
    // it as grey concrete — the reflective Water plane below covers the flat
    // water area, leaving the concrete wall/basin visible around it.
    if (poolSurfaceMesh.material) {
      poolSurfaceMesh.material.map = null;
      poolSurfaceMesh.material.color = new THREE.Color(0xcbc3b4); // warm concrete
      poolSurfaceMesh.material.roughness = 0.9;
      poolSurfaceMesh.material.metalness = 0.0;
      applyWallNormal(poolSurfaceMesh.material, 6);
      poolSurfaceMesh.material.needsUpdate = true;
    }

    console.warn(`[water] pool bounds size=(${sizeX.toFixed(1)}, ${sizeZ.toFixed(1)}) center=(${center.x.toFixed(1)}, ${center.y.toFixed(1)}, ${center.z.toFixed(1)}) top=${box.max.y.toFixed(2)}`);
  }

  const waterGeometry = new THREE.PlaneGeometry(sizeX, sizeZ);

  waterPlane = new Water(
    waterGeometry,
    {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: textureLoader.load('textures/water/Water_1_M_Normal.jpg', (texture) => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      }),
      sunDirection: sunLight.position.clone().normalize(),
      sunColor: 0xfff0dd,          // warm sun glint
      waterColor: 0x1f6ba5,        // clearer pool blue
      distortionScale: 3.0,        // soft ripples
      fog: scene.fog !== undefined
    }
  );

  waterPlane.rotation.x = - Math.PI / 2;
  waterPlane.position.copy(poolPosition);
  scene.add(waterPlane);
  console.log("Reflective Water shader added over pool footprint.");
}

// --- Setup View Navigator (Apple Dock-style icon rail, right edge) ---
const VIEW_ICONS = [
  // 0 Stairs
  '<svg viewBox="0 0 24 24"><path d="M4 20h4v-4h4v-4h4V8h4V4"/></svg>',
  // 1 Right Top View (arrow up-right)
  '<svg viewBox="0 0 24 24"><path d="M7 17L17 7"/><path d="M9 7h8v8"/></svg>',
  // 2 Left Top View (arrow up-left)
  '<svg viewBox="0 0 24 24"><path d="M17 17L7 7"/><path d="M15 7H7v8"/></svg>',
  // 3 Main Bedroom (bed)
  '<svg viewBox="0 0 24 24"><path d="M3 7v11"/><path d="M3 14h18v4"/><path d="M21 14v-3a2 2 0 0 0-2-2h-9v5"/><circle cx="6.5" cy="10.5" r="1.5"/></svg>',
  // 4 Back View (rotate arrow)
  '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
  // 5 Top Living Room (sofa)
  '<svg viewBox="0 0 24 24"><path d="M5 12V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="M3 14a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v5H3v-5z"/></svg>',
  // 6 Right Pool (waves)
  '<svg viewBox="0 0 24 24"><path d="M2 10c2 0 2-1.5 4-1.5S8 10 10 10s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/><path d="M2 16c2 0 2-1.5 4-1.5S8 16 10 16s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/></svg>',
  // 7 Default View (home)
  '<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 9.5V20h14V9.5"/></svg>'
];

function setupHotspots() {
  const nav = document.getElementById('view-nav');
  if (!nav) return;

  // Home first, separator, then the tour views.
  const displayOrder = [7, 0, 1, 2, 3, 4, 5, 6];
  const items = [];
  displayOrder.forEach((id, idx) => {
    const pt = hotspots.find((h) => h.id === id);
    if (!pt) return;

    const btn = document.createElement('button');
    btn.className = 'view-nav-item';
    btn.innerHTML = (VIEW_ICONS[pt.id] || VIEW_ICONS[0]) + `<span class="label">${pt.name}</span>`;
    btn.addEventListener('click', () => {
      items.forEach((el) => el.classList.remove('active'));
      btn.classList.add('active');
      flyToTarget(pt.camPos, pt.lookAt);
      track('view_navigate', { view_name: pt.name });
    });
    nav.appendChild(btn);
    items.push(btn);

    // Separator between Home and the tour views (macOS dock style)
    if (idx === 0) {
      const sep = document.createElement('div');
      sep.className = 'view-nav-sep';
      nav.appendChild(sep);
    }
  });

  // Dock magnification — icons swell as the cursor nears them (gaussian-ish
  // falloff on vertical distance, like the macOS Dock).
  nav.addEventListener('mousemove', (e) => {
    items.forEach((btn) => {
      const r = btn.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2));
      const s = 1 + 0.55 * Math.max(0, 1 - d / 110);
      btn.style.transform = `scale(${s.toFixed(3)})`;
    });
  });
  nav.addEventListener('mouseleave', () => {
    items.forEach((btn) => { btn.style.transform = 'scale(1)'; });
  });
}

// --- Smooth Camera Transitions ---
function flyToTarget(targetCamPos, targetLookAt) {
  // Disable controls temporarily during transition
  controls.enabled = false;

  // Tween Camera Position
  gsap.to(camera.position, {
    x: targetCamPos.x,
    y: targetCamPos.y,
    z: targetCamPos.z,
    duration: 2.2,
    ease: 'power2.inOut',
    onUpdate: () => {
      camera.lookAt(controls.target);
    }
  });

  // Tween Controls Target Coordinate
  gsap.to(controls.target, {
    x: targetLookAt.x,
    y: targetLookAt.y,
    z: targetLookAt.z,
    duration: 2.2,
    ease: 'power2.inOut',
    onComplete: () => {
      controls.enabled = true;
    }
  });
}

// --- UI Button and Slider Events Binding ---
function bindUIEvents() {
  // Continue explore button — kept as a manual fallback; reuses revealScene()
  if (continueBtn) {
    continueBtn.addEventListener('click', revealScene);
  }

  // Drawers trigger buttons
  const customizeBtn = document.querySelector('.customize-btn');
  const customizeClose = document.getElementById('customize-close');
  const customizeDrawer = document.querySelector('.customize-container');

  const aboutBtn = document.querySelector('.about-btn');
  const aboutClose = document.getElementById('about-close');
  const aboutDrawer = document.querySelector('.about-container');

  customizeBtn.addEventListener('click', () => {
    aboutDrawer.classList.add('hidden');
    customizeDrawer.classList.remove('hidden');
    track('drawer_open', { drawer: 'customize' });
  });

  customizeClose.addEventListener('click', () => {
    customizeDrawer.classList.add('hidden');
  });

  aboutBtn.addEventListener('click', () => {
    customizeDrawer.classList.add('hidden');
    aboutDrawer.classList.remove('hidden');
    track('drawer_open', { drawer: 'about' });
  });

  aboutClose.addEventListener('click', () => {
    aboutDrawer.classList.add('hidden');
  });

  // Music toggle button
  const musicBtn = document.getElementById('music-btn');
  musicBtn.addEventListener('click', () => {
    if (isMusicPlaying) {
      audioSound.pause();
      isMusicPlaying = false;
    } else {
      audioSound.play();
      isMusicPlaying = true;
    }
    musicBtn.classList.toggle('muted', !isMusicPlaying);
    track('music_toggle', { state: isMusicPlaying ? 'on' : 'off' });
  });

  // Sun elevation/azimuth sliders (spherical, like the reference)
  const elevSlider = document.getElementById('elevation');
  const azimSlider = document.getElementById('azimuth');

  elevSlider.addEventListener('input', (e) => {
    sunAngles.elevation = parseFloat(e.target.value);
    updateSunFromAngles();
  });

  azimSlider.addEventListener('input', (e) => {
    sunAngles.azimuth = parseFloat(e.target.value);
    updateSunFromAngles();
  });

  // Track slider adjustments once per gesture ('change' fires on release,
  // unlike 'input' which fires continuously while dragging)
  [['elevation', elevSlider], ['azimuth', azimSlider]].forEach(([axis, el]) => {
    el.addEventListener('change', (e) => track('sun_adjust', { axis, value: Number(e.target.value) }));
  });

  // Preset Buttons (Sunset vs Midday)
  const middayBtn = document.querySelector('.midday-btn');
  const sunsetBtn = document.querySelector('.sunset-btn');

  middayBtn.addEventListener('click', () => {
    sunsetBtn.classList.remove('active');
    middayBtn.classList.add('active');
    
    // Animate sun settings to midday (high sun, from the north-east)
    gsap.to(sunAngles, { elevation: 79, azimuth: 45, duration: 1.5, onUpdate: updateSunFromAngles });
    gsap.to(sunLight.color, { r: 1.0, g: 0.98, b: 0.95, duration: 1.5 }); // white daylight
    gsap.to(sunLight, { intensity: 7.0, duration: 1.5 });
    track('sun_preset', { preset: 'midday' });
  });

  sunsetBtn.addEventListener('click', () => {
    middayBtn.classList.remove('active');
    sunsetBtn.classList.add('active');

    // Animate sun settings to warm sunset (low sun)
    gsap.to(sunAngles, { elevation: 29, azimuth: 51, duration: 1.5, onUpdate: updateSunFromAngles });
    gsap.to(sunLight.color, { r: 1.0, g: 0.81, b: 0.54, duration: 1.5 }); // warm gold
    gsap.to(sunLight, { intensity: 7.2, duration: 1.5 });
    track('sun_preset', { preset: 'sunset' });
  });

  // Post-processing switch (SSAO + bloom)
  const ppBtn = document.getElementById('toggle-pp');
  if (ppBtn) {
    // Reflect the default state (on) in the switch UI
    ppBtn.classList.toggle('on', isPostProcessingEnabled);
    ppBtn.setAttribute('aria-checked', String(isPostProcessingEnabled));
    ppBtn.addEventListener('click', () => {
      isPostProcessingEnabled = !isPostProcessingEnabled;
      ppBtn.classList.toggle('on', isPostProcessingEnabled);
      ppBtn.setAttribute('aria-checked', String(isPostProcessingEnabled));
      track('post_processing_toggle', { enabled: isPostProcessingEnabled });
    });
  }
}

// --- Tweakpane Debug Panel (live tuning) ---
// Only mounts when the URL contains #debug (e.g. localhost:5174/#debug).
function setupDebugPanel() {
  if (!window.location.hash.includes('debug')) {
    // React to the hash being added/removed without requiring a manual reload.
    window.addEventListener('hashchange', () => window.location.reload(), { once: true });
    return;
  }
  window.addEventListener('hashchange', () => window.location.reload(), { once: true });

  const container = document.createElement('div');
  container.style.cssText =
    'position:fixed; top:70px; left:12px; width:280px; z-index:60;';
  document.body.appendChild(container);

  const pane = new Pane({ container, title: 'Debug — Archviz' });

  // Wall / floor normal map
  const wall = { scale: 1.0, repeat: 20 };
  const fWall = pane.addFolder({ title: 'Wall Normal' });
  fWall.addBinding(wall, 'scale', { min: 0, max: 3, step: 0.05 }).on('change', (ev) => {
    wallMaterials.forEach((m) => m.normalScale && m.normalScale.set(ev.value, ev.value));
  });
  fWall.addBinding(wall, 'repeat', { min: 1, max: 200, step: 1 }).on('change', (ev) => {
    if (_wallNormalBase) _wallNormalBase.repeat.set(ev.value, ev.value);
  });

  // Glass
  const glass = { opacity: 0.6, metalness: 0.5, roughness: 0.05, reflect: 1.8, tint: '#a8b8c2' };
  const fGlass = pane.addFolder({ title: 'Glass' });
  fGlass.addBinding(glass, 'opacity', { min: 0, max: 1, step: 0.05 }).on('change', (ev) => {
    glassMaterials.forEach((m) => { m.opacity = ev.value; });
  });
  fGlass.addBinding(glass, 'metalness', { min: 0, max: 1, step: 0.05 }).on('change', (ev) => {
    glassMaterials.forEach((m) => { m.metalness = ev.value; });
  });
  fGlass.addBinding(glass, 'roughness', { min: 0, max: 1, step: 0.01 }).on('change', (ev) => {
    glassMaterials.forEach((m) => { m.roughness = ev.value; });
  });
  fGlass.addBinding(glass, 'reflect', { min: 0, max: 4, step: 0.1, label: 'env reflect' }).on('change', (ev) => {
    glassMaterials.forEach((m) => { m.envMapIntensity = ev.value; });
  });
  fGlass.addBinding(glass, 'tint').on('change', (ev) => {
    glassMaterials.forEach((m) => { m.color.set(ev.value); });
  });

  // Sun & renderer
  const sun = { intensity: 7.2, exposure: renderer.toneMappingExposure };
  const fSun = pane.addFolder({ title: 'Sun / Render' });
  fSun.addBinding(sun, 'intensity', { min: 0, max: 15, step: 0.1 }).on('change', (ev) => {
    if (sunLight) sunLight.intensity = ev.value;
  });
  fSun.addBinding(sun, 'exposure', { min: 0, max: 3, step: 0.05 }).on('change', (ev) => {
    renderer.toneMappingExposure = ev.value;
  });
  const env = { intensity: 0.5 };
  fSun.addBinding(env, 'intensity', { min: 0, max: 3, step: 0.05, label: 'env light' }).on('change', (ev) => {
    scene.environmentIntensity = ev.value;
  });

  // Grass
  const grass = { color: '#5d8046', wind: 0.25, windSpeed: 2.0, tip: '#7eb529', root: '#325222', solid: false };
  const fGrass = pane.addFolder({ title: 'Grass' });
  fGrass.addBinding(grass, 'color', { label: 'ground' }).on('change', (ev) => {
    grassMaterials.forEach((m) => m.color.set(ev.value));
  });
  fGrass.addBinding(grass, 'wind', { min: 0, max: 1, step: 0.01 }).on('change', (ev) => {
    if (grassShader) grassShader.uniforms.uWindStrength.value = ev.value;
  });
  fGrass.addBinding(grass, 'windSpeed', { min: 0, max: 6, step: 0.1, label: 'wind speed' }).on('change', (ev) => {
    if (grassShader) grassShader.uniforms.uWindSpeed.value = ev.value;
  });
  fGrass.addBinding(grass, 'root', { label: 'blade root' }).on('change', (ev) => {
    if (grassShader) grassShader.uniforms.uRootColor.value.set(ev.value);
  });
  fGrass.addBinding(grass, 'tip', { label: 'blade tip' }).on('change', (ev) => {
    if (grassShader) grassShader.uniforms.uTipColor.value.set(ev.value);
  });
  fGrass.addBinding(grass, 'solid', { label: 'solid (perf)' }).on('change', (ev) => {
    if (window._grassMaterial) {
      window._grassMaterial.transparent = !ev.value;
      window._grassMaterial.needsUpdate = true;
    }
  });

  // Water
  const water = { color: '#1f6ba5', distortion: 3.0 };
  const fWater = pane.addFolder({ title: 'Water' });
  fWater.addBinding(water, 'color').on('change', (ev) => {
    if (waterPlane) waterPlane.material.uniforms['waterColor'].value.set(ev.value);
  });
  fWater.addBinding(water, 'distortion', { min: 0, max: 8, step: 0.1 }).on('change', (ev) => {
    if (waterPlane) waterPlane.material.uniforms['distortionScale'].value = ev.value;
  });

  // Lens flare
  const flare = { glow: 1400, ghosts: 1.0, warmth: '#ff9438' };
  const fFlare = pane.addFolder({ title: 'Lens Flare' });
  fFlare.addBinding(flare, 'glow', { min: 0, max: 3000, step: 25, label: 'glow size' }).on('change', (ev) => {
    if (flareGlow) flareGlow.size = ev.value;
  });
  fFlare.addBinding(flare, 'warmth', { label: 'glow tint' }).on('change', (ev) => {
    if (flareGlow) flareGlow.color.set(ev.value);
  });
  fFlare.addBinding(flare, 'ghosts', { min: 0, max: 3, step: 0.05, label: 'ghost scale' }).on('change', (ev) => {
    flareGhosts.forEach((g) => { g.size = g.userData_baseSize * ev.value; });
  });

  // Hotspot camera tuning — orbit to a good view, then Capture to store it
  // on the selected hotspot (and log it so the values can be baked into code).
  const hs = { index: 0 };
  const fHs = pane.addFolder({ title: 'Hotspot Cameras' });
  fHs.addBinding(hs, 'index', {
    label: 'hotspot',
    options: Object.fromEntries(hotspots.map((h) => [h.name, h.id]))
  });
  fHs.addButton({ title: 'Fly to hotspot' }).on('click', () => {
    const pt = hotspots[hs.index];
    flyToTarget(pt.camPos, pt.lookAt);
  });
  fHs.addButton({ title: 'Capture current view' }).on('click', () => {
    const pt = hotspots[hs.index];
    pt.camPos = camera.position.clone();
    pt.lookAt = controls.target.clone();
    console.warn(`[hotspot] "${pt.name}" camPos(${pt.camPos.x.toFixed(1)}, ${pt.camPos.y.toFixed(1)}, ${pt.camPos.z.toFixed(1)}) lookAt(${pt.lookAt.x.toFixed(1)}, ${pt.lookAt.y.toFixed(1)}, ${pt.lookAt.z.toFixed(1)})`);
  });

  // Post-processing
  const post = { enabled: true, ssao: 8, bloom: 0.10 };
  const fPost = pane.addFolder({ title: 'Post FX' });
  fPost.addBinding(post, 'enabled', { label: 'post-processing' }).on('change', (ev) => {
    isPostProcessingEnabled = ev.value;
  });
  fPost.addBinding(post, 'ssao', { min: 0, max: 32, step: 1, label: 'SSAO radius' }).on('change', (ev) => {
    if (ssaoPass) ssaoPass.kernelRadius = ev.value;
  });
  fPost.addBinding(post, 'bloom', { min: 0, max: 2, step: 0.05 }).on('change', (ev) => {
    if (bloomPass) bloomPass.strength = ev.value;
  });
}

// --- Window Resize Handler ---
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  if (ssaoPass) ssaoPass.setSize(window.innerWidth, window.innerHeight);
  if (bloomPass) bloomPass.setSize(window.innerWidth, window.innerHeight);
}

// --- Animation / Render Loop ---
function animate() {
  requestAnimationFrame(animate);

  const delta = clock.getDelta();

  // 1. Update controls (skipped while the intro animation owns the camera —
  // controls.update() would force lookAt(controls.target) every frame)
  if (!introActive) controls.update();

  // 2. Update Water plane uniform timer for flowing ripples
  if (waterPlane) {
    waterPlane.material.uniforms['time'].value += delta * 0.4;
  }

  // 2b. Drive the grass wind shader
  if (grassShader) {
    grassShader.uniforms.uTime.value = elapsedTime;
  }

  // 3. Update active bird animation mixers + circling flight paths
  elapsedTime += delta;
  mixers.forEach(mixer => {
    mixer.update(delta);
  });
  birdFlights.forEach((b) => {
    const a = elapsedTime * b.speed + b.phase;
    const x = Math.cos(a) * b.radius;
    const z = Math.sin(a) * b.radius;
    const y = b.height + Math.sin(elapsedTime * 0.5 + b.phase) * 0.8; // gentle bob
    // Face along the direction of travel (look slightly ahead on the path)
    const ahead = 0.05;
    b.obj.position.set(x, y, z);
    b.obj.lookAt(
      Math.cos(a + ahead) * b.radius,
      y,
      Math.sin(a + ahead) * b.radius
    );
  });

  // 4. Render Scene — through the post-processing composer when enabled,
  // otherwise straight to screen.
  if (isPostProcessingEnabled && composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// --- Start the App ---
init();
