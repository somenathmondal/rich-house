# ThreeJS Seashore House | Architectural Visualization

This is an interactive 3D architectural visualization built with **Three.js**, **GSAP**, and **Vite**, recreating Anderson Mancini's original luxury villa showcase (`https://threejs-archviz.vercel.app/`).

## 🚀 Quick Start

1. **Navigate to project directory**:
   ```bash
   cd seashore-archviz
   ```
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Start the local development server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173/` in your browser.

## 📁 Project Structure

*   `public/`
    *   `models/beach-house.glb` - Main high-fidelity 3D architectural model.
    *   `models/bird.glb` - Animated seagull models with skeletal animations.
    *   `textures/spruit_sunrise_1K.exr` - Equirectangular sunrise HDRI environment map.
    *   `textures/water/` - Water ripple normal maps.
    *   `sounds/music_loop.mp3` - Ambient background sound track.
*   `src/`
    *   `main.js` - Core WebGL setup, scene loaders, lighting, dynamic sliders, and camera hotspots.
    *   `style.css` - Custom editorial layouts, glassmorphic drawers, and responsive layouts.
*   `index.html` - Base HTML boilerplate with loaders and overlay controls.

## 🛠 Features Implemented

1.  **High-Fidelity Lighting**: Uses `spruit_sunrise_1K.exr` environment map for photorealistic soft reflection maps and shadows.
2.  **Interactive Sun controls**: X/Y/Z range sliders directly calculate the angle/elevation of the directional sun.
3.  **Flowing Water Shaders**: Utilizes Three.js examples `Water` helper to overlay normal maps and animate flowing ripples on the pool.
4.  **HTML 3D Hotspots**: Projects 3D vector coordinates onto 2D screen positions, with occlusion raycasting (hiding points behind building structures).
5.  **Cinematic Camera Travels**: Leverages GSAP to slide both the camera position and the target coordinates of OrbitControls smoothly.
