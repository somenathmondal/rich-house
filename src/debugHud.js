/**
 * Zero-overhead lazy-loaded #debug Performance HUD for Rich House.
 * Only imported when URL hash contains #debug. Restores all hooks cleanly on unmount.
 */
export function mountDebugHud({ getStats, onClose }) {
  const root = document.createElement('div');
  root.id = 'rich-house-debug-hud';
  Object.assign(root.style, {
    position: 'fixed',
    bottom: '16px',
    left: '16px',
    zIndex: '100001',
    width: '280px',
    background: 'rgba(38, 19, 19, 0.92)',
    color: '#FFFFFF',
    border: '1px solid rgba(255, 255, 255, 0.16)',
    borderRadius: '14px',
    boxShadow: '0 16px 40px rgba(0, 0, 0, 0.45)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: '11px',
    lineHeight: '1.45',
    userSelect: 'none',
    pointerEvents: 'auto',
  });

  let collapsed = false;
  let frameCalls = 0;
  let frameVerts = 0;
  let lastFrameCalls = 0;
  let lastFrameTris = 0;
  const frameTimes = [];
  const fpsHistory = [];
  let lcpMs = null;
  let fcpMs = null;

  try {
    const paints = performance.getEntriesByType('paint');
    const fcp = paints.find((p) => p.name === 'first-contentful-paint');
    if (fcp) fcpMs = Math.round(fcp.startTime);
    const po = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length) lcpMs = Math.round(entries[entries.length - 1].startTime);
    });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
    root._po = po;
  } catch {}

  const proto = typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null;
  const origDrawElements = proto?.drawElements;
  const origDrawArrays = proto?.drawArrays;
  const origDrawElementsInst = proto?.drawElementsInstanced;
  const origDrawArraysInst = proto?.drawArraysInstanced;

  if (proto && origDrawElements && origDrawArrays) {
    proto.drawElements = function (mode, count) {
      frameCalls++;
      frameVerts += count;
      return origDrawElements.apply(this, arguments);
    };
    proto.drawArrays = function (mode, first, count) {
      frameCalls++;
      frameVerts += count;
      return origDrawArrays.apply(this, arguments);
    };
    if (origDrawElementsInst) {
      proto.drawElementsInstanced = function (mode, count, type, offset, instanceCount) {
        frameCalls++;
        frameVerts += count * instanceCount;
        return origDrawElementsInst.apply(this, arguments);
      };
    }
    if (origDrawArraysInst) {
      proto.drawArraysInstanced = function (mode, first, count, instanceCount) {
        frameCalls++;
        frameVerts += count * instanceCount;
        return origDrawArraysInst.apply(this, arguments);
      };
    }
  }

  let rafId = 0;
  let lastNow = performance.now();
  function tick(now) {
    const dt = now - lastNow;
    lastNow = now;
    lastFrameCalls = frameCalls;
    lastFrameTris = Math.round(frameVerts / 3);
    frameCalls = 0;
    frameVerts = 0;
    if (dt > 0 && dt < 1000) {
      frameTimes.push(dt);
      if (frameTimes.length > 90) frameTimes.shift();
    }
    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  let latestSnapshot = {};

  function render() {
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const avgMs = frameTimes.length ? frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length : 0;
    const p95Ms = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    const fps = avgMs > 0 ? Math.min(120, 1000 / avgMs) : 0;

    fpsHistory.push(fps);
    if (fpsHistory.length > 48) fpsHistory.shift();

    const mem = performance.memory;
    const nav = performance.getEntriesByType('navigation')[0];
    const resources = performance.getEntriesByType('resource');
    const transferBytes = resources.reduce((sum, r) => sum + (r.transferSize || 0), nav?.transferSize || 0);
    const extra = getStats ? getStats() : {};

    latestSnapshot = {
      fps: +fps.toFixed(1),
      avgFrameMs: +avgMs.toFixed(1),
      p95FrameMs: +p95Ms.toFixed(1),
      drawCalls: lastFrameCalls,
      triangles: lastFrameTris,
      geometries: extra.geometries ?? 0,
      textures: extra.textures ?? 0,
      postFx: extra.postFx ? 'ON (Half-Res SSAO)' : 'OFF',
      shadows: extra.shadowAutoUpdate ? 'EVERY FRAME' : 'ON-DEMAND (4K)',
      jsHeapMB: mem ? +(mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) : null,
      dclMs: nav ? Math.round(nav.domContentLoadedEventEnd) : 0,
      fcpMs,
      lcpMs,
      transferKB: Math.round(transferBytes / 1024),
    };

    const fpsColor = fps >= 55 ? '#4ade80' : fps >= 38 ? '#facc15' : '#f87171';
    const sparkPoints = fpsHistory
      .map((v, i) => `${((i / Math.max(1, fpsHistory.length - 1)) * 240).toFixed(1)},${(32 - Math.min(1, v / 65) * 28).toFixed(1)}`)
      .join(' ');

    root.style.width = collapsed ? 'auto' : '280px';
    root.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;${collapsed ? '' : 'border-bottom:1px solid rgba(255,255,255,0.1)'}">
        <div style="display:flex;align-items:center;gap:7px">
          <span style="width:8px;height:8px;border-radius:50%;background:${fpsColor};box-shadow:0 0 8px ${fpsColor}"></span>
          <strong style="letter-spacing:0.08em">PERF DEBUG</strong>
          <span style="color:${fpsColor};font-weight:700">${fps.toFixed(0)} FPS</span>
        </div>
        <div style="display:flex;gap:6px">
          <button data-act="toggle" style="background:rgba(255,255,255,0.12);color:#fff;border:none;border-radius:6px;padding:2px 7px;font-size:10px;cursor:pointer">${collapsed ? '+' : '−'}</button>
          <button data-act="close" style="background:rgba(255,255,255,0.12);color:#fff;border:none;border-radius:6px;padding:2px 7px;font-size:10px;cursor:pointer">✕</button>
        </div>
      </div>
      ${collapsed ? '' : `
      <div style="padding:10px 12px;display:flex;flex-direction:column;gap:9px">
        <div style="background:rgba(0,0,0,0.28);border-radius:8px;padding:6px 8px;border:1px solid rgba(255,255,255,0.08)">
          <div style="display:flex;justify-content:space-between;font-size:10px;opacity:0.85;margin-bottom:4px">
            <span>AVG ${latestSnapshot.avgFrameMs} ms</span>
            <span>P95 ${latestSnapshot.p95FrameMs} ms</span>
            <span>POST ${extra.postFx ? 'ON' : 'OFF'}</span>
          </div>
          <svg width="240" height="34" viewBox="0 0 240 34" style="display:block;width:100%">
            <line x1="0" y1="6" x2="240" y2="6" stroke="rgba(74,222,128,0.22)" stroke-dasharray="3 3" />
            ${sparkPoints ? `<polyline fill="none" stroke="${fpsColor}" stroke-width="1.75" stroke-linejoin="round" points="${sparkPoints}" />` : ''}
          </svg>
        </div>
        <div>
          <div style="font-size:9px;letter-spacing:0.14em;opacity:0.65;margin-bottom:4px">WEBGL RENDERER</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px">
            <div>Draw Calls: <strong>${latestSnapshot.drawCalls}</strong></div>
            <div>Tris: <strong>${(latestSnapshot.triangles / 1e6).toFixed(2)}M</strong></div>
            <div>Geoms: <strong>${latestSnapshot.geometries}</strong></div>
            <div>Textures: <strong>${latestSnapshot.textures}</strong></div>
            <div style="grid-column:1 / -1">Shadows: <strong style="color:#4ade80">${latestSnapshot.shadows}</strong></div>
          </div>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.1);padding-top:8px">
          <div style="font-size:9px;letter-spacing:0.14em;opacity:0.65;margin-bottom:4px">MEMORY &amp; LOAD</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px">
            <div>JS Heap: <strong>${latestSnapshot.jsHeapMB !== null ? `${latestSnapshot.jsHeapMB} MB` : 'N/A'}</strong></div>
            <div>Transfer: <strong>${latestSnapshot.transferKB} KB</strong></div>
            <div>DCL: <strong>${latestSnapshot.dclMs} ms</strong></div>
            <div>FCP: <strong>${latestSnapshot.fcpMs !== null ? `${latestSnapshot.fcpMs} ms` : '—'}</strong></div>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:2px">
          <span style="font-size:9px;opacity:0.6">URL hash: #debug</span>
          <button data-act="copy" style="background:rgba(255,255,255,0.14);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:3px 8px;font-size:10px;cursor:pointer">Copy JSON</button>
        </div>
      </div>`}
    `;
  }

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'toggle') {
      collapsed = !collapsed;
      render();
    } else if (act === 'copy') {
      navigator.clipboard?.writeText(JSON.stringify(latestSnapshot, null, 2));
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy JSON'; }, 1200);
    } else if (act === 'close') {
      onClose?.();
    }
  });

  document.body.appendChild(root);
  render();
  const interval = window.setInterval(render, 250);

  return function unmount() {
    cancelAnimationFrame(rafId);
    clearInterval(interval);
    root._po?.disconnect();
    root.remove();
    if (proto && origDrawElements && origDrawArrays) {
      proto.drawElements = origDrawElements;
      proto.drawArrays = origDrawArrays;
      if (origDrawElementsInst) proto.drawElementsInstanced = origDrawElementsInst;
      if (origDrawArraysInst) proto.drawArraysInstanced = origDrawArraysInst;
    }
  };
}
