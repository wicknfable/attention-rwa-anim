/**
 * sketch.js
 * ------------------------------------------------------------------------
 * Application entry point — orchestration only.
 *
 * Wires Camera, lattice generation, Renderer, and Simulation into a p5
 * instance-mode sketch suitable for Webflow (or any host page).
 *
 * Mount:
 *   createAttentionSketch(containerElement)
 *   // or auto-mount on #canvas-container / [data-attention-rwa]
 *
 * Render order each frame:
 *   background → inactive lattice → activated edges →
 *   completed extrusions (painter's algorithm) → travelling signals
 *
 * Pause / resume:
 *   IntersectionObserver — stop when the container leaves the viewport
 *   Page Visibility API — stop when the browser tab is hidden
 *   Simulation state is preserved; resume continues seamlessly
 *
 * Performance (fixed absolute background):
 *   Camera never pans — lattice is projected to screen once per resize
 *   and redrawn from that cache. Target FPS is intentionally modest.
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
 *   Host element or CSS selector. Defaults to `#canvas-container`, then
 *   `[data-attention-rwa]`, then `document.body`.
 * @returns {p5} The p5 instance (for teardown via `.remove()` if needed).
 */
export function createAttentionSketch(container) {
  const host = resolveContainer(container);

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

    /** @type {ResizeObserver|null} */
    let resizeObserver = null;
    /** @type {IntersectionObserver|null} */
    let intersectionObserver = null;

    /**
     * Screen-space lattice cache. Rebuilt only on resize — the camera is
     * static for absolute-positioned backgrounds, so projecting thousands
     * of edges every frame was pure waste.
     * @type {{ edges: Array, nodes: Array } | null}
     */
    let screenLattice = null;

    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      syncLoop();
    };

    function rebuildScreenLattice() {
      const visibleBounds = camera.getVisibleWorldBounds(Theme.grid.overscanFactor);
      const latticeData = generateLatticeData(visibleBounds);
      screenLattice = projectLatticeToScreen(latticeData, camera);
    }

    function applyHostSize(width, height) {
      p.resizeCanvas(width, height);
      camera.x = width * 0.10;
      camera.y = height * -0.05;
      camera.resize(width, height);
      rebuildScreenLattice();
    }

    p.setup = () => {
      // Prefer smooth playback over retina sharpness for production embeds.
      // Absolute backgrounds run continuously — keep density low.
      p.pixelDensity(1);

      const { width, height } = measureHost(host);
      const canvas = p.createCanvas(width, height);
      canvas.parent(host);

      // Decorative layer — never intercept clicks on overlying UI.
      if (canvas.elt) {
        canvas.elt.style.pointerEvents = 'none';
        canvas.elt.style.display = 'block';
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

      // Container-driven resize (Webflow embeds are rarely window-sized).
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          const size = measureHost(host);
          if (size.width === p.width && size.height === p.height) return;
          applyHostSize(size.width, size.height);
        });
        resizeObserver.observe(host);
      }

      // Pause when the animation scrolls out of view.
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
      if (!running) return;
      if (!screenLattice) rebuildScreenLattice();

      // 1. Advance simulation — pure state update, no drawing.
      simulation.update(p.deltaTime);

      // 2. Snapshot draw data so the lattice pass can cull hidden edges.
      const simDrawData = simulation.getDrawData();

      // 3. Inactive lattice from screen-space cache (no world→screen work).
      renderer.renderScreenLattice(screenLattice, {
        occludedEdgeKeys: simDrawData.occludedEdgeKeys,
      });

      // 4. Simulation layer: activated edges → extrusions → signals.
      renderer.drawSimulation(camera, simDrawData);
    };

    // Fallback when ResizeObserver is unavailable.
    p.windowResized = () => {
      const size = measureHost(host);
      applyHostSize(size.width, size.height);
    };

    function syncLoop() {
      const shouldRun = inViewport && pageVisible;
      if (shouldRun === running) return;
      running = shouldRun;
      if (running) {
        p.loop();
      } else {
        p.noLoop();
      }
    }

    // Expose teardown for SPA / Webflow re-inits.
    p._attentionTeardown = () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (resizeObserver) resizeObserver.disconnect();
      if (intersectionObserver) intersectionObserver.disconnect();
    };
  };

  return new p5(sketch, host);
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
    const depth = t * t * (3 - 2 * t); // same smoothstep as renderer
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

/** Resolves a mount target without hardcoding document.body as the only option. */
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

// Auto-mount for standalone / Webflow embeds that include this module.
createAttentionSketch();
