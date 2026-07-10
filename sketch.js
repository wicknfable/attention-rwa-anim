/**
 * sketch.js
 * ------------------------------------------------------------------------
 * Client showcase lifecycle:
 *   1. Bake lattice once → CSS backdrop (static)
 *   2. Live p5 for Theme.lifecycle.liveDurationMs (~8s): signals + extrusions
 *   3. Freeze → short settle → bake final PNG onto the backdrop
 *   4. Tear down p5 completely → zero ongoing CPU
 *
 * Mount:
 *   createAttentionSketch(containerElement)
 * ------------------------------------------------------------------------
 */

import { Theme } from './theme.js';
import { Camera } from './camera.js';
import { generateLatticeData } from './grid.js';
import { Renderer } from './renderer.js';
import { Simulation } from './simulation.js';

/**
 * @param {HTMLElement|string} [container]
 * @returns {p5}
 */
export function createAttentionSketch(container) {
  const host = resolveContainer(container);
  ensureHostStyle(host);

  const sketch = (p) => {
    /** @type {Camera} */
    let camera;
    /** @type {Renderer} */
    let renderer;
    /** @type {Simulation} */
    let simulation;

    let running = true;
    let pageVisible = !document.hidden;
    let bakedFinal = false;

    /** @type {ResizeObserver|null} */
    let resizeObserver = null;

    /** @type {{ edges: Array, nodes: Array, bandCount: number } | null} */
    let screenLattice = null;

    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      if (bakedFinal) return;
      if (pageVisible && !running) {
        running = true;
        p.loop();
      } else if (!pageVisible && running) {
        running = false;
        p.noLoop();
      }
    };

    function rebuildScreenLattice() {
      const visibleBounds = camera.getVisibleWorldBounds(Theme.grid.overscanFactor);
      const latticeData = generateLatticeData(visibleBounds);
      screenLattice = projectLatticeToScreen(latticeData, camera);
      if (!bakedFinal) {
        applyLatticeBackground(host, renderer.bakeLatticeDataUrl(screenLattice));
      }
    }

    function applyHostSize(width, height) {
      if (bakedFinal) return;
      p.resizeCanvas(width, height);
      camera.x = width * 0.10;
      camera.y = height * -0.05;
      camera.resize(width, height);
      rebuildScreenLattice();
    }

    function teardownListeners() {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
    }

    /**
     * Bake the settled scene to a static CSS image, then destroy p5.
     * After this the page only shows a background-image — no draw loop.
     */
    function freezeAndBake() {
      if (bakedFinal) return;
      bakedFinal = true;
      running = false;
      p.noLoop();

      try {
        if (!screenLattice) rebuildScreenLattice();
        const simDrawData = simulation.getDrawData();
        const url = renderer.bakeFinalDataUrl(screenLattice, camera, simDrawData);
        applyLatticeBackground(host, url);
        host.style.visibility = '';
      } catch (err) {
        console.warn('[attention-rwa] bake failed', err);
      }

      teardownListeners();

      // Remove live canvas + offscreen graphics from the DOM.
      try {
        if (typeof p.remove === 'function') p.remove();
      } catch (_) {
        if (p.canvas) p.canvas.style.display = 'none';
      }
    }

    p.setup = () => {
      p.pixelDensity(1);

      const { width, height } = measureHost(host);
      const canvas = p.createCanvas(width, height);
      canvas.parent(host);

      if (canvas.elt) {
        const el = canvas.elt;
        el.style.pointerEvents = 'none';
        el.style.display = 'block';
        el.style.background = 'transparent';
        el.style.position = 'absolute';
        el.style.inset = '0';
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.zIndex = '0';
        el.setAttribute('aria-hidden', 'true');
      }

      camera     = new Camera(width * 0.10, height * -0.05, 1);
      renderer   = new Renderer(p);
      simulation = new Simulation();

      camera.resize(width, height);
      rebuildScreenLattice();

      p.frameRate(Theme.performance?.targetFps ?? 30);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          if (bakedFinal) return;
          const size = measureHost(host);
          if (size.width === p.width && size.height === p.height) return;
          applyHostSize(size.width, size.height);
        });
        resizeObserver.observe(host);
      }

      document.addEventListener('visibilitychange', onVisibilityChange);
    };

    p.draw = () => {
      if (bakedFinal) return;
      if (!pageVisible) return;
      if (!screenLattice) rebuildScreenLattice();

      simulation.update(p.deltaTime);

      if (simulation.isReadyToBake()) {
        freezeAndBake();
        return;
      }

      const simDrawData = simulation.getDrawData();
      renderer.clearTransparent();
      renderer.drawSimulation(camera, simDrawData);
    };

    p.windowResized = () => {
      if (bakedFinal) return;
      const size = measureHost(host);
      applyHostSize(size.width, size.height);
    };

    p._attentionTeardown = () => {
      teardownListeners();
    };
  };

  return new p5(sketch, host);
}

function applyLatticeBackground(host, dataUrl) {
  const layer = ensureBackdrop(host);
  layer.style.backgroundImage = `url(${dataUrl})`;
  layer.style.backgroundSize = '100% 100%';
  layer.style.backgroundPosition = 'center';
  layer.style.backgroundRepeat = 'no-repeat';
  layer.style.backgroundColor = Theme.color.background;
}

function ensureBackdrop(host) {
  let layer = host.querySelector('[data-attention-backdrop]');
  if (!layer) {
    layer = document.createElement('div');
    layer.setAttribute('data-attention-backdrop', '');
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '0',
      pointerEvents: 'none',
      backgroundSize: '100% 100%',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    });
    host.insertBefore(layer, host.firstChild);
  }
  return layer;
}

function ensureHostStyle(host) {
  host.setAttribute('data-attention-rwa', '');
  const style = host.style;
  style.pointerEvents = 'none';

  const computed = getComputedStyle(host);
  if (computed.position === 'static') {
    style.position = 'absolute';
  }
  if (!style.inset && !style.top && !style.left) {
    style.top = '0';
    style.left = '0';
    style.right = '0';
    style.bottom = '0';
  }
  if (!style.width && computed.width === 'auto') {
    style.width = '100%';
  }
  if (!style.height && (computed.height === 'auto' || computed.height === '0px')) {
    style.height = '100%';
  }
  if (!style.zIndex) {
    style.zIndex = '0';
  }
  if (computed.overflow === 'visible') {
    style.overflow = 'hidden';
  }
}

function projectLatticeToScreen(latticeData, camera) {
  const vh = camera.viewportHeight;
  const fadeBandPx = Math.max(1, vh * Theme.depth.fadeBandHeight);
  const bandCount = Theme.grid.depthBands || 6;

  const edges = [];
  for (const edge of latticeData.edges) {
    const a = camera.worldToScreen(edge.x1, edge.y1);
    const b = camera.worldToScreen(edge.x2, edge.y2);
    const midY = (a.y + b.y) * 0.5;
    const t = Math.min(1, Math.max(0, midY / fadeBandPx));
    const depth = t * t * (3 - 2 * t);
    const band = Math.min(bandCount - 1, Math.floor(depth * bandCount));
    edges.push({
      key: edge.key,
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      band,
      depth,
    });
  }

  const nodes = [];
  if (Theme.performance?.drawLatticeNodes) {
    for (const node of latticeData.nodes) {
      const s = camera.worldToScreen(node.x, node.y);
      const t = Math.min(1, Math.max(0, s.y / fadeBandPx));
      const depth = t * t * (3 - 2 * t);
      const band = Math.min(bandCount - 1, Math.floor(depth * bandCount));
      nodes.push({ x: s.x, y: s.y, band, depth });
    }
  }

  return { edges, nodes, bandCount };
}

function resolveContainer(container) {
  if (container instanceof HTMLElement) return container;
  if (typeof container === 'string') {
    const el = document.querySelector(container);
    if (el) return el;
  }
  return (
    document.getElementById('canvas-container') ||
    document.querySelector('[data-attention-rwa]') ||
    document.body
  );
}

function measureHost(host) {
  const rect = host.getBoundingClientRect();
  const width  = Math.max(1, Math.floor(rect.width  || host.clientWidth  || window.innerWidth));
  const height = Math.max(1, Math.floor(rect.height || host.clientHeight || window.innerHeight));
  return { width, height };
}

createAttentionSketch();
