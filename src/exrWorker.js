import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

// Decodes and sanitizes the 1K EXR HDRI completely off the main thread so the
// 2D blueprint loader never drops a single frame during EXR decompression.
self.onmessage = (e) => {
  try {
    const loader = new EXRLoader();
    loader.setDataType(THREE.FloatType);
    const parsed = loader.parse(e.data.buffer);
    const data = parsed.data;
    const MAX = 64;
    let bad = 0;
    let hot = 0;
    let peak = 0;

    if (data && data.length) {
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (!Number.isFinite(v)) {
          data[i] = MAX;
          bad++;
        } else if (v > MAX) {
          data[i] = MAX;
          hot++;
          if (v > peak) peak = v;
        } else if (v > peak) {
          peak = v;
        }
      }
    }

    self.postMessage(
      {
        width: parsed.width,
        height: parsed.height,
        data,
        format: parsed.format,
        colorSpace: parsed.colorSpace,
        type: parsed.type,
        bad,
        hot,
        peak,
      },
      data && data.buffer ? [data.buffer] : []
    );
  } catch (err) {
    self.postMessage({ error: String(err && err.message ? err.message : err) });
  }
};
