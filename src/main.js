import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import { gsap } from 'gsap';
import './style.css';

// --- Global Core Variables ---
let scene, camera, renderer, controls;
let sunLight, sunHelper;
let waterPlane;
let mixers = []; // For bird animations
let clock = new THREE.Clock();
let isPostProcessingEnabled = false;

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
  if (continueBtn) continueBtn.classList.remove('hidden');
};

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
  renderer.toneMappingExposure = 1.0;
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

  // 7. Load Models
  loadGLTFModels();

  // 8. Setup Hotspot Click Handlers
  setupHotspots();

  // 9. Bind UI Events
  bindUIEvents();

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

  // Sun Light (Directional)
  sunLight = new THREE.DirectionalLight(0xffd59a, 6.0); // Warm sunset orange
  sunLight.position.set(38, 27, 31); // Default sunset position
  sunLight.castShadow = true;
  
  // Shadow quality optimization
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 150;
  
  const d = 40;
  sunLight.shadow.camera.left = -d;
  sunLight.shadow.camera.right = d;
  sunLight.shadow.camera.top = d;
  sunLight.shadow.camera.bottom = -d;
  sunLight.shadow.bias = -0.0003;

  scene.add(sunLight);
}

// --- Setup Environment Map (EXR) ---
function setupEnvironment() {
  const exrLoader = new EXRLoader(loadingManager);
  
  exrLoader.load('textures/spruit_sunrise_1K.exr', (texture) => {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = texture;
    console.log("EXR Environment loaded as background successfully!");
  });
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
        

        // Optimise glass materials to use environment reflections
        if (child.name.toLowerCase().includes('glass') || (child.material && child.material.name && child.material.name.toLowerCase().includes('glass'))) {
          child.material.transparent = true;
          child.material.opacity = 0.3;
          child.material.roughness = 0.0;
          child.material.metalness = 1.0;
        }
      }
    });

    scene.add(houseMesh);
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

// --- Setup Real-Time Water Shader ---
function setupWater() {
  const waterGeometry = new THREE.PlaneGeometry(16, 12);
  const textureLoader = new THREE.TextureLoader(loadingManager);

  // Locate the pool position (or fallback to pool deck coordinates)
  let poolPosition = new THREE.Vector3(10.5, 0.38, -3.2);

  waterPlane = new Water(
    waterGeometry,
    {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: textureLoader.load('textures/water/Water_1_M_Normal.jpg', (texture) => {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      }),
      sunDirection: sunLight.position.clone().normalize(),
      sunColor: 0xffffff,
      waterColor: 0x012c40,
      distortionScale: 4.0,
      fog: scene.fog !== undefined
    }
  );

  waterPlane.rotation.x = - Math.PI / 2;
  waterPlane.position.copy(poolPosition);
  scene.add(waterPlane);
  console.log("Water Plane added over pool mesh.");
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
  // Continue explore button (closes loading loader screen)
  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      gsap.to(loaderOverlay, {
        opacity: 0,
        duration: 1.0,
        onComplete: () => {
          loaderOverlay.style.display = 'none';
          
          // Fade in main logo title splash
          gsap.fromTo('#section-logo', { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 1.2, delay: 0.5 });
          
          // Auto start music play
          if (audioSound && !isMusicPlaying) {
            audioSound.play();
            isMusicPlaying = true;
            document.getElementById('music-btn').innerText = "🔊";
          }
        }
      });
    });
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
    gsap.to(sunLight.color, { r: 1.0, g: 0.83, b: 0.6, duration: 1.5 }); // sunset orange
    gsap.to(sunLight, { intensity: 6.0, duration: 1.5 });

    xSlider.value = 38;
    ySlider.value = 27;
    zSlider.value = 31;
  });

  // Main scroll button - flies camera to first hotspot (Stairs)
  document.getElementById('button-scroll').addEventListener('click', () => {
    const pt = hotspots[0];
    flyToTarget(pt.camPos, pt.lookAt);
  });
}

// --- Window Resize Handler ---
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
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

  // 5. Render Scene
  renderer.render(scene, camera);
}

// --- Start the App ---
init();
