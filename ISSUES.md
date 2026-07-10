# Known Issues / Gap List vs. Reference (threejs-archviz.vercel.app)

Working baseline: reflective pool water + GLB pool wall, warm sun, shadow
acne/aliasing fixes, SMAA behind post-processing toggle, lens flare,
wallTexture2 normal map (scale 1 / repeat 20), Tweakpane debug panel.

## Open issues

1. **Glass material reads black/flat** *(fixing now)*
   - Current: `metalness 1.0, opacity 0.3` → dark mirror that reflects
     nothing (no envMap on the material), so facades go black from most
     angles. Reference glass is bright, sky-reflective, and see-through.

2. **Jagged shadow sawtooth on the pool rim** — partially improved
   (4096 shadow map + tighter frustum + normalBias), still visible up close.
   May need contact-hardening tweak, larger normalBias, or geometry-level fix.

3. **Birds too large / too low** — read as close crows rather than the
   reference's distant flock. Shrink (~0.15 → ~0.08) and raise/spread.

4. **Water tone vs reference** — ours leans navy/reflective; reference is a
   brighter turquoise with softer ripples. Tune `waterColor` + distortion
   (live-tunable in Tweakpane → bake values once picked).

5. **Sun controls are raw X/Y/Z sliders** — reference uses intuitive
   elevation/azimuth (spherical) controls in the Customize panel.

6. **About panel content incomplete** — reference has project blurb,
   social links, and Awwwards badge.

7. **favicon 404** — `public/favicon.svg` exists but `index.html` has no
   `<link rel="icon">` tag.

8. **Lens flare position** — attached to the directional light at
   (38,27,31); may not line up with the HDRI's painted sun. Verify + align.

9. **SSAO/bloom untuned** — post-processing chain exists behind the toggle;
   kernel radius / bloom strength need eyeballing (Tweakpane sliders exist).

10. **Pool corner mismatch** — small step where the pool wall edge meets the
    water at the near corner (cosmetic, low priority).

## Fixed (for reference)

- ✅ Loading screen gate — now auto-enters scene on load
- ✅ Cyan tiled pool texture — replaced with reflective Water shader
- ✅ Pool wall "missing/black" — was shadow acne; fixed with normalBias
- ✅ Shadow stripes on roofs — bias/normalBias fix
- ✅ Flat plastic walls/floors — wallTexture2.jpg normal map
- ✅ Post-processing (SSAO + bloom + SMAA) wired behind Customize toggle
- ✅ Lens flare added (lensflare1/22/3 textures)
- ✅ Tweakpane debug panel (wall normal, sun, water, post FX)
