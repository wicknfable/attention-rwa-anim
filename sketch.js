/**
 * sketch.js
 * ------------------------------------------------------------------------
 * Application entry point — orchestration only.
 *
 * Pause conditions (any one stops the loop; state is kept):
 *   - Page scrolled past Theme.lifecycle.scrollPauseAt (default 20%)
 *   - Host leaves viewport (IntersectionObserver)
 *   - Browser tab hidden (Page Visibility API)
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
    let scrollAllows = true;
    let bakedFinal = false;

    /** @type {ResizeObserver|null} */
    let resizeObserver = null;
    /** @type {IntersectionObserver|null} */
    let intersectionObserver = null;
    /** @type {number|null} */
    let scrollRaf = null;

    /** @type {{ edges: Array, nodes: Array, bandCount: number } | null} */
    let screenLattice = null;

    const onVisibilityChange = () => {
      pageVisible = !document.hidden;
      syncLoop();
    };

    const onScrollOrResize = () => {
      if (bakedFinal) return;
      if (scrollRaf != null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        updateScrollGate();
      });
    };

    function updateScrollGate() {
      const life = Theme.lifecycle || {};
      const threshold = life.scrollPauseAt;
      if (threshold == null || threshold === false) {
        scrollAllows = true;
        applyScrollVisibility(true);
        syncLoop();
        return;
      }

      const progress = getPageScrollProgress();
      const past = progress >= Number(threshold);

      if (past) {
        scrollAllows = false;
      } else if (life.scrollResume !== false) {
        scrollAllows = true;
      }
      // scrollResume === false: once past threshold, stay paused.

      applyScrollVisibility(scrollAllows);
      syncLoop();
    }

    /** Hide absolute/fixed host when scroll-paused so it can't bleed through. */
    function applyScrollVisibility(allowed) {
      if (Theme.lifecycle?.hideWhenScrollPaused === false) return;
      if (bakedFinal) return;
      host.style.visibility = allowed ? '' : 'hidden';
      // Also hide live canvas explicitly (some Webflow stacks ignore parent visibility).
      if (p.canvas) {
        p.canvas.style.visibility = allowed ? '' : 'hidden';
      }
      const backdrop = host.querySelector('[data-attention-backdrop]');
      if (backdrop) {
        backdrop.style.visibility = allowed ? '' : 'hidden';
      }
    }

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
      window.removeEventListener('scroll', onScrollOrResize, true);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      if (scrollRaf != null) cancelAnimationFrame(scrollRaf);
      if (resizeObserver) resizeObserver.disconnect();
      if (intersectionObserver) intersectionObserver.disconnect();
      host.style.visibility = '';
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
      // Capture phase + document: Webflow/Lenis often scroll a nested root
      // or transform the page without reliable window scrollTop alone.
      window.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
      document.addEventListener('scroll', onScrollOrResize, { passive: true, capture: true });
      window.addEventListener('resize', onScrollOrResize, { passive: true });
      updateScrollGate();
    };

    p.draw = () => {
      if (bakedFinal) return;

      // Per-frame scroll check — does not rely on scroll events (Webflow/smooth-scroll).
      updateScrollGate();

      if (!running) return;
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
      const shouldRun = inViewport && pageVisible && scrollAllows;
      if (shouldRun === running) return;
      running = shouldRun;
      if (running) {
        p.loop();
      } else {
        p.noLoop();
        // Keep a cheap poll alive so scroll-back can resume even after noLoop.
        // (Webflow may not fire scroll events we hear; rAF poll covers that.)
        startScrollPoll();
      }
    }

    /** Lightweight rAF poll while paused — catches scroll without a draw loop. */
    let scrollPollRaf = null;
    function startScrollPoll() {
      if (scrollPollRaf != null || bakedFinal) return;
      const tick = () => {
        scrollPollRaf = null;
        if (bakedFinal || running) return;
        updateScrollGate();
        if (!running) {
          scrollPollRaf = requestAnimationFrame(tick);
        }
      };
      scrollPollRaf = requestAnimationFrame(tick);
    }

    p._attentionTeardown = () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('scroll', onScrollOrResize, true);
      document.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
      if (scrollRaf != null) cancelAnimationFrame(scrollRaf);
      if (scrollPollRaf != null) cancelAnimationFrame(scrollPollRaf);
      if (resizeObserver) resizeObserver.disconnect();
      if (intersectionObserver) intersectionObserver.disconnect();
    };
  };

  return new p5(sketch, host);
}

/**
 * Best-effort page scroll progress in [0, 1].
 * Prefer window/document scrollY. Also reads CSS translateY on common
 * smooth-scroll wrappers (Lenis / Locomotive / Webflow IX) where scrollY
 * can stay near 0 while the page visually moves.
 */
let _nestedScrollCache = 0;
let _nestedScrollSampleAt = 0;

function getPageScrollProgress() {
  const now = performance.now();
  if (now - _nestedScrollSampleAt > 250) {
    _nestedScrollSampleAt = now;
    _nestedScrollCache = Math.max(findNestedScrollY(), findTransformScrollY());
  }

  const doc = document.documentElement;
  const body = document.body;
  const scrollY = Math.max(
    window.scrollY || 0,
    window.pageYOffset || 0,
    doc ? doc.scrollTop : 0,
    body ? body.scrollTop : 0,
    _nestedScrollCache
  );

  const viewH = window.innerHeight || (doc && doc.clientHeight) || 1;
  const docH = Math.max(
    doc ? doc.scrollHeight : 0,
    doc ? doc.offsetHeight : 0,
    body ? body.scrollHeight : 0,
    body ? body.offsetHeight : 0,
    viewH
  );
  const max = Math.max(1, docH - viewH);
  return Math.min(1, Math.max(0, scrollY / max));
}

function findNestedScrollY() {
  let best = 0;
  const candidates = [
    document.scrollingElement,
    document.documentElement,
    document.body,
    document.querySelector('[data-scroll-container]'),
    document.querySelector('main'),
  ];
  for (const el of candidates) {
    if (!el || !(el.scrollTop > best)) continue;
    best = el.scrollTop;
  }
  return best;
}

/** Lenis / Locomotive often translate a wrapper instead of changing scrollTop. */
function findTransformScrollY() {
  const candidates = [
    document.querySelector('[data-scroll-container]'),
    document.querySelector('.lenis'),
    document.querySelector('[data-engine="locomotive"]'),
    document.body,
  ];
  let best = 0;
  for (const el of candidates) {
    if (!el) continue;
    const t = window.getComputedStyle(el).transform;
    if (!t || t === 'none') continue;
    // matrix(a,b,c,d,tx,ty) or matrix3d(..., ty at index 13)
    const nums = t.match(/-?\d+\.?\d*/g);
    if (!nums) continue;
    let ty = 0;
    if (t.startsWith('matrix3d') && nums.length >= 14) {
      ty = Math.abs(parseFloat(nums[13]));
    } else if (nums.length >= 6) {
      ty = Math.abs(parseFloat(nums[5]));
    }
    if (ty > best) best = ty;
  }
  return best;
}

function applyLatticeBackground(host, dataUrl) {
  // Prefer a dedicated backdrop child so we never fight Webflow section
  // backgrounds or paint over sibling hero UI via stacking quirks.
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
  // Fill parent (typical Webflow absolute background layer).
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
  // Stay behind hero UI. Content wrappers should use z-index: 1+.
  if (!style.zIndex) {
    style.zIndex = '0';
  }
  if (computed.overflow === 'visible') {
    style.overflow = 'hidden';
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
