/**
 * sketch.js
 * ------------------------------------------------------------------------
 * Application entry point — orchestration only.
 *
 * Lifecycle (one-way showcase mode):
 *   1. Bake lattice once → CSS background on the host (static, free)
 *   2. Animate signals + extrusions on a transparent canvas overlay
 *   3. At ~35% fill (or freezeAtCells): stop signals, finish rises
 *   4. Bake final composite (lattice + extrusions) → CSS background
 *   5. Remove the canvas — zero ongoing CPU / GPU
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
 * Creates and mounts the Attention RWA lattice animation.
 *
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
    let inViewport = true;
    let pageVisible = !document.hidden;
    let bakedFinal = false;

    /** @type {ResizeObserver|null} */
    let resizeObserver = null;
    /** @type {IntersectionObserver|null} */
    let intersectionObserver = null;

    /** @type {{ edges: Array, nodes: Array, bandCount: number } | null} */
    let screenLattice = null;

    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      syncLoop();
    };

    function rebuildScreenLattice() {
      const visibleBounds = camera.getVisibleWorldBounds(Theme.grid.overscanFactor);
      const latticeData = generateLatticeData(visibleBounds);
      screenLattice = projectLatticeToScreen(latticeData, camera);
      // Static lattice → CSS. Live canvas only draws pulses + extrusions.
      if (!bakedFinal) {
        applyLatticeBackground(host, renderer.bakeLatticeDataUrl(screenLattice));
      }
    }

    function applyHostSize(width, height) {
      if (bakedFinal) {
        // Frozen showcase: just scale the baked image via CSS; no re-sim.
        return;
      }
      p.resizeCanvas(width, height);
      camera.x = width * 0.10;
      camera.y = height * -0.05;
      camera.resize(width, height);
      rebuildScreenLattice();
    }

    function freezeAndBake() {
      if (bakedFinal) return;
      bakedFinal = true;

      const simDrawData = simulation.getDrawData();
      // Stop the draw loop immediately — bake from current settled state.
      p.noLoop();
      running = false;

      const url = renderer.bakeFinalDataUrl(screenLattice, camera, simDrawData);
      applyLatticeBackground(host, url);

      // Canvas no longer needed — CSS image is the permanent showcase.
      if (p.canvas) {
        p.canvas.style.display = 'none';
      }

      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (resizeObserver) resizeObserver.disconnect();
      if (intersectionObserver) intersectionObserver.disconnect();
    }

    p.setup = () => {
      p.pixelDensity(1);

      const { width, height } = measureHost(host);
      const canvas = p.createCanvas(width, height);
      canvas.parent(host);

      if (canvas.elt) {
        canvas.elt.style.pointerEvents = 'none';
        canvas.elt.style.display = 'block';
        canvas.elt.style.background = 'transparent';
      }

      const cameraOffsetX = width * 0.10;
      const cameraOffsetY = height * -0.05;

      camera     = new Camera(cameraOffsetX, cameraOffsetY, 1);
      renderer   = new Renderer(p);
      simulation = new Simulation();

      camera.resize(width, height);
      rebuildScreenLattice();

      const targetFps = Theme.performance?.targetFps ?? 30;
      p.frameRate(targetFps);

      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          if (bakedFinal) return;
          const size = measureHost(host);
          if (size.width === p.width && size.height === p.height) return;
          applyHostSize(size.width, size.height);
        });
        resizeObserver.observe(host);
      }

      if (typeof IntersectionObserver !== 'undefined') {
        intersectionObserver = new IntersectionObserver(
          (entries) => {
            inViewport = entries.some((e) => e.isIntersecting);
            syncLoop();
          },
          { threshold: 0.01 }
        );
        intersectionObserver.observe(host);
      }

      document.addEventListener('visibilitychange', onVisibilityChange);
    };

    p.draw = () => {
      if (!running || bakedFinal) return;
      if (!screenLattice) rebuildScreenLattice();

      simulation.update(p.deltaTime);

      if (simulation.isReadyToBake()) {
        freezeAndBake();
        return;
      }

      const simDrawData = simulation.getDrawData();

      // Transparent overlay — lattice lives in CSS underneath.
      renderer.clearTransparent();
      renderer.drawSimulation(camera, simDrawData);
    };

    p.windowResized = () => {
      if (bakedFinal) return;
      const size = measureHost(host);
      applyHostSize(size.width, size.height);
    };

    function syncLoop() {
      if (bakedFinal) return;
      const shouldRun = inViewport && pageVisible;
      if (shouldRun === running) return;
      running = shouldRun;
      if (running) {
        p.loop();
      } else {
        p.noLoop();
      }
    }

    p._attentionTeardown = () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (resizeObserver) resizeObserver.disconnect();
      if (intersectionObserver) intersectionObserver.disconnect();
    };
  };

  return new p5(sketch, host);
}

function applyLatticeBackground(host, dataUrl) {
  host.style.backgroundImage = `url(${dataUrl})`;
  host.style.backgroundSize = '100% 100%';
  host.style.backgroundPosition = 'center';
  host.style.backgroundRepeat = 'no-repeat';
  host.style.backgroundColor = Theme.color.background;
}

function ensureHostStyle(host) {
  const style = host.style;
  if (!style.position || style.position === 'static') {
    // Keep existing absolute/fixed from Webflow; only set relative as fallback.
    if (getComputedStyle(host).position === 'static') {
      style.position = 'relative';
    }
  }
}

/**
 * Projects world lattice into screen pixels once. Depth band is precomputed
 * so the renderer can batch strokes without per-edge math every frame.
 */
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
