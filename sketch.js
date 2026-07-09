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

    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      syncLoop();
    };

    p.setup = () => {
      // Prefer smooth 60 FPS over retina sharpness for production embeds.
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
      p.frameRate(60);

      // Container-driven resize (Webflow embeds are rarely window-sized).
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          const size = measureHost(host);
          if (size.width === p.width && size.height === p.height) return;
          p.resizeCanvas(size.width, size.height);
          camera.x = size.width * 0.10;
          camera.y = size.height * -0.05;
          camera.resize(size.width, size.height);
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

      // 1. Advance simulation — pure state update, no drawing.
      simulation.update(p.deltaTime);

      // 2. Snapshot draw data so the lattice pass can clip hidden edges.
      const simDrawData = simulation.getDrawData();

      // 3. Inactive lattice (background, visible edges, nodes).
      const visibleBounds = camera.getVisibleWorldBounds(Theme.grid.overscanFactor);
      const latticeData   = generateLatticeData(visibleBounds);
      renderer.render(camera, latticeData, {
        occludedEdgeKeys: simDrawData.occludedEdgeKeys,
        partialSurfaces:   simDrawData.partialSurfaces,
      });

      // 4. Simulation layer: activated edges → extrusions → signals.
      renderer.drawSimulation(camera, simDrawData);
    };

    // Fallback when ResizeObserver is unavailable.
    p.windowResized = () => {
      const size = measureHost(host);
      p.resizeCanvas(size.width, size.height);
      camera.x = size.width * 0.10;
      camera.y = size.height * -0.05;
      camera.resize(size.width, size.height);
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
