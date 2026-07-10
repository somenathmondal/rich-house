import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
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
let mixers = []; // For bird animations
let clock = new THREE.Clock();
let isPostProcessingEnabled = false;

// --- Post-processing ---
let composer, ssaoPass, bloomPass;

// --- Pool water ---
let poolSurfaceMesh = null; // baked tiled pool surface, replaced by Water shader

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
const hotspots = [
  { id: 0, name: "Stairs", position: new THREE.Vector3(-1.8, 1.2, -6.5), camPos: new THREE.Vector3(-4, 2, -3), lookAt: new THREE.Vector3(-1.8, 1.2, -6.5) },
  { id: 1, name: "Right Top View", position: new THREE.Vector3(12.5, 7.5, 4.5), camPos: new THREE.Vector3(22, 10, -2), lookAt: new THREE.Vector3(12.5, 7.5, 4.5) },
  { id: 2, name: "Left Top View", position: new THREE.Vector3(-14, 8, 4.5), camPos: new THREE.Vector3(-22, 11, -1), lookAt: new THREE.Vector3(-14, 8, 4.5) },
  { id: 3, name: "Main Bedroom", position: new THREE.Vector3(-6, 4.2, -3.2), camPos: new THREE.Vector3(-8, 5, 2), lookAt: new THREE.Vector3(-6, 4.2, -3.2) },
  { id: 4, name: "Back View", position: new THREE.Vector3(0, 3, -16), camPos: new THREE.Vector3(2, 6, -26), lookAt: new THREE.Vector3(0, 3, -16) },
  { id: 5, name: "Top Living Room", position: new THREE.Vector3(0.5, 4.2, 1.5), camPos: new THREE.Vector3(0, 5.5, 7), lookAt: new THREE.Vector3(0.5, 4.2, 1.5) },
  { id: 6, name: "Right Pool", position: new THREE.Vector3(11, 0.4, -3), camPos: new THREE.Vector3(18, 2.5, 3), lookAt: new THREE.Vector3(11, 0.4, -3) }
];

let pointElements = [];
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

// --- Audio Player ---
let audioListener, audioSound, audioLoader;
let isMusicPlaying = false;

// --- Initialize Loading Manager ---
const loadingManager = new THREE.LoadingManager();
const loaderBar = document.getElementById('loadingBar');
const loaderText = document.getElementById('loaderText');
const loaderOverlay = document.getElementById('loaderOverlay');
const continueBtn = document.getElementById('btn-continue-explore');

loadingManager.onProgress = (url, itemsLoaded, itemsTotal) => {
  const progress = Math.round((itemsLoaded / itemsTotal) * 100);
  if (loaderBar) loaderBar.style.width = `${progress}%`;
  if (loaderText) loaderText.style.innerText = `Loading Seashore House... ${progress}%`;
};

loadingManager.onLoad = () => {
  if (loaderText) loaderText.innerText = "Loaded! Ready to explore.";
  // Skip the "Explore Scene" gate — reveal the 3D scene automatically.
  revealScene();
};

// Fade out the loading overlay and reveal the scene. Used on auto-load and
// kept wired to the button as a manual fallback.
function revealScene() {
  if (!loaderOverlay || loaderOverlay.dataset.revealed === 'true') return;
  loaderOverlay.dataset.revealed = 'true';

  gsap.to(loaderOverlay, {
    opacity: 0,
    duration: 1.0,
    onComplete: () => {
      loaderOverlay.style.display = 'none';

      // Fade in main logo title splash
      gsap.fromTo('#section-logo', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 1.2, delay: 0.3 });

      // Try to start ambient music. Browsers keep the AudioContext suspended
      // until a user gesture, so it may stay silent until the first click.
      if (audioSound && audioSound.buffer && !isMusicPlaying) {
        try {
          audioSound.play();
          isMusicPlaying = true;
          const btn = document.getElementById('music-btn');
          if (btn) btn.innerText = "🔊";
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
  camera.position.set(28, 14, 32); // Default starting position

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
  controls.target.set(0, 2, 0);

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
function setupLensflare() {
  const loader = new THREE.TextureLoader(loadingManager);
  const glow = loader.load('textures/lensflare1.jpg');   // main soft glow
  const ring = loader.load('textures/lensflare3.jpg');   // halo ring
  const burst = loader.load('textures/lensflare22.jpeg'); // chromatic ghosts

  const lensflare = new Lensflare();
  // Main glow sits on the sun itself (distance 0).
  lensflare.addElement(new LensflareElement(glow, 500, 0, sunLight.color));
  // Secondary ghosts stream along the axis toward screen centre.
  lensflare.addElement(new LensflareElement(burst, 60, 0.4));
  lensflare.addElement(new LensflareElement(ring, 90, 0.6));
  lensflare.addElement(new LensflareElement(burst, 70, 0.75));
  lensflare.addElement(new LensflareElement(ring, 140, 0.9));

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
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.25, 0.4, 0.9);
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
  });

  // Load animated Seagull birds
  gltfLoader.load('models/bird.glb', (gltf) => {
    const birdModel = gltf.scene;
    birdModel.scale.set(0.15, 0.15, 0.15);

    // Create 3 bird instances flying at different positions
    const birdPositions = [
      new THREE.Vector3(-15, 12, 10),
      new THREE.Vector3(10, 15, -15),
      new THREE.Vector3(5, 14, 5)
    ];

    birdPositions.forEach((pos, index) => {
      const birdClone = birdModel.clone();
      birdClone.position.copy(pos);
      scene.add(birdClone);

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
    const WATER_DROP = 0.45; // lower = water sits deeper in the basin
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

// --- Setup HTML Hotspots ---
function setupHotspots() {
  hotspots.forEach(pt => {
    const el = document.querySelector(`.point-${pt.id}`);
    if (el) {
      pointElements.push({
        position: pt.position,
        element: el,
        camPos: pt.camPos,
        lookAt: pt.lookAt
      });

      // Fly camera on click
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        flyToTarget(pt.camPos, pt.lookAt);
      });
    }
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

// --- Screen Space Hotspot Projection ---
function updateHotspots() {
  const tempV = new THREE.Vector3();

  pointElements.forEach(pt => {
    tempV.copy(pt.position);
    tempV.project(camera); // project 3D coordinate onto normalized device coordinates (NDC)

    const isBehindCamera = tempV.z > 1;

    if (isBehindCamera) {
      pt.element.classList.remove('visible');
    } else {
      // Raycasting check for occlusion (hiding points behind architecture walls)
      if (houseMesh) {
        const direction = pt.position.clone().sub(camera.position).normalize();
        raycaster.set(camera.position, direction);

        const intersects = raycaster.intersectObjects(houseMesh.children, true);
        const distanceToPoint = camera.position.distanceTo(pt.position);

        // If there's an intersection closer than the point, it is occluded
        const isOccluded = intersects.length > 0 && intersects[0].distance < (distanceToPoint - 0.2);

        if (isOccluded) {
          pt.element.classList.remove('visible');
          return;
        }
      }

      // Convert NDC (-1 to 1) to screen pixels (width & height bounds)
      const x = (tempV.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-(tempV.y) * 0.5 + 0.5) * window.innerHeight;

      pt.element.style.transform = `translate(${x}px, ${y}px)`;
      pt.element.classList.add('visible');
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
  });

  customizeClose.addEventListener('click', () => {
    customizeDrawer.classList.add('hidden');
  });

  aboutBtn.addEventListener('click', () => {
    customizeDrawer.classList.add('hidden');
    aboutDrawer.classList.remove('hidden');
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
      musicBtn.innerText = "🔇";
    } else {
      audioSound.play();
      isMusicPlaying = true;
      musicBtn.innerText = "🔊";
    }
  });

  // Sunlight position sliders binding
  const xSlider = document.getElementById('xposition');
  const ySlider = document.getElementById('yposition');
  const zSlider = document.getElementById('zposition');

  xSlider.addEventListener('input', (e) => {
    sunLight.position.x = parseFloat(e.target.value);
    if (waterPlane) waterPlane.material.uniforms['sunDirection'].value.copy(sunLight.position).normalize();
  });

  ySlider.addEventListener('input', (e) => {
    sunLight.position.y = parseFloat(e.target.value);
    if (waterPlane) waterPlane.material.uniforms['sunDirection'].value.copy(sunLight.position).normalize();
  });

  zSlider.addEventListener('input', (e) => {
    sunLight.position.z = parseFloat(e.target.value);
    if (waterPlane) waterPlane.material.uniforms['sunDirection'].value.copy(sunLight.position).normalize();
  });

  // Preset Buttons (Sunset vs Midday)
  const middayBtn = document.querySelector('.midday-btn');
  const sunsetBtn = document.querySelector('.sunset-btn');

  middayBtn.addEventListener('click', () => {
    sunsetBtn.classList.remove('active');
    middayBtn.classList.add('active');
    
    // Animate sun settings to midday
    gsap.to(sunLight.position, { x: 10, y: 70, z: 10, duration: 1.5 });
    gsap.to(sunLight.color, { r: 1.0, g: 0.98, b: 0.95, duration: 1.5 }); // white daylight
    gsap.to(sunLight, { intensity: 7.0, duration: 1.5 });
    
    xSlider.value = 10;
    ySlider.value = 70;
    zSlider.value = 10;
  });

  sunsetBtn.addEventListener('click', () => {
    middayBtn.classList.remove('active');
    sunsetBtn.classList.add('active');

    // Animate sun settings to warm sunset
    gsap.to(sunLight.position, { x: 38, y: 27, z: 31, duration: 1.5 });
    gsap.to(sunLight.color, { r: 1.0, g: 0.81, b: 0.54, duration: 1.5 }); // warm gold
    gsap.to(sunLight, { intensity: 7.2, duration: 1.5 });

    xSlider.value = 38;
    ySlider.value = 27;
    zSlider.value = 31;
  });

  // Main scroll button - flies camera to first hotspot (Stairs)
  document.getElementById('button-scroll').addEventListener('click', () => {
    const pt = hotspots[0];
    flyToTarget(pt.camPos, pt.lookAt);
  });

  // Post-processing toggle (SSAO + bloom)
  const ppBtn = document.getElementById('toggle-pp');
  if (ppBtn) {
    ppBtn.addEventListener('click', () => {
      isPostProcessingEnabled = !isPostProcessingEnabled;
      ppBtn.classList.toggle('active', isPostProcessingEnabled);
      ppBtn.innerText = isPostProcessingEnabled
        ? 'Post Processing: ON'
        : 'Toggle Post Processing';
    });
  }
}

// --- Tweakpane Debug Panel (live tuning) ---
function setupDebugPanel() {
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

  // Water
  const water = { color: '#1f6ba5', distortion: 3.0 };
  const fWater = pane.addFolder({ title: 'Water' });
  fWater.addBinding(water, 'color').on('change', (ev) => {
    if (waterPlane) waterPlane.material.uniforms['waterColor'].value.set(ev.value);
  });
  fWater.addBinding(water, 'distortion', { min: 0, max: 8, step: 0.1 }).on('change', (ev) => {
    if (waterPlane) waterPlane.material.uniforms['distortionScale'].value = ev.value;
  });

  // Post-processing
  const post = { enabled: false, ssao: 8, bloom: 0.25 };
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

  // 1. Update controls
  controls.update();

  // 2. Update Water plane uniform timer for flowing ripples
  if (waterPlane) {
    waterPlane.material.uniforms['time'].value += delta * 0.4;
  }

  // 3. Update active bird animation mixers
  mixers.forEach(mixer => {
    mixer.update(delta);
  });

  // 4. Project 3D Hotspots onto 2D viewport
  updateHotspots();

  // 5. Render Scene — through the post-processing composer when enabled,
  // otherwise straight to screen.
  if (isPostProcessingEnabled && composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

// --- Start the App ---
init();
