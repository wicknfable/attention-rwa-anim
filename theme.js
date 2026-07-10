/**
 * theme.js
 * ------------------------------------------------------------------------
 * Visual and timing constants only — no p5, camera, or grid math.
 * Tune palette, lattice spacing, signal pace, heights, and world balance here.
 * ------------------------------------------------------------------------
 */

export const Theme = {
  // ---- Colour palette --------------------------------------------------
  color: {
    background: '#FAFAF8',
    gridLine: '#E3E5E8',
    node: '#BEC4CB',
    futureSurface: '#F3F4F5',
    futureLeftFace: '#E7E8EA',
    futureRightFace: '#D9DDE0',
    accent: '#ED0C32',
  },

  // ---- Isometric grid geometry ------------------------------------------
  grid: {
    // Angle of the isometric projection, in degrees, measured from the
    // horizontal. 30° gives the classic isometric "diamond" lattice.
    isoAngleDegrees: 28,

    // Distance between adjacent lattice nodes along the lattice's own
    // u/v axes (in lattice "world" units, before camera zoom).
    spacing: 80,

    // Node visual size, in pixels, before screen-space scaling/fade.
    nodeSize: 3,

    // Grid line stroke width, in pixels, before screen-space fade.
    lineWidth: 1,

    // How many extra rows/columns of lattice to draw beyond what is
    // strictly visible on screen, so panning/zooming never reveals a
    // hard edge. Expressed as a multiplier on the visible span.
    overscanFactor: 1.05,

    // Discrete depth bands for lattice stroke batching (fewer p5 state changes).
    depthBands: 6,
  },


  // ---- Screen-space atmospheric depth effect -----------------------------
  depth: {
    // Fraction of the viewport height (from the top) over which the
    // fade gradient is applied. Below this fraction, geometry is fully
    // crisp/opaque. Extended to push more of the lattice into atmosphere.
    fadeBandHeight: 0.72,

    // Opacity at the very top of the fade band. Near-zero so the top
    // 10-20% of the screen almost vanishes into the background.
    minOpacity: 0.05,

    // Opacity at and below the bottom of the fade band.
    maxOpacity: 1.0,

    // Minimum size fraction for nodes/lines at the top of the fade band.
    minScale: 0.72,
  },

  // ---- Activated edge appearance (after a signal passes through) --------
  activatedEdge: {
    // Slightly darker than the inactive grid line (#E3E5E8) so activated
    // paths are legible without being loud — only used if drawScars is true.
    color: '#C5CAD0',
    lineWidth: 1.5,
    // Logic-only lifetime for closing diamonds. Scars are NOT drawn on the
    // lattice by default — the red pulse is the visible trail; extrusions
    // are the lasting mark. Keep this long enough that a loop can still form.
    trailTtlMs: 1600,
    // How often to sweep expired trails.
    expireCheckMs: 100,
    // When false, activated paths never stain the lattice — only extrusions
    // and the live signal pulse remain visible.
    drawScars: false,
  },

  // ---- Construction signal -----------------------------------------------
  signal: {
    // Travel speed in world-space units per second. At default zoom (1),
    // world units map 1:1 to screen pixels.
    speedWorldPerSec: 122,
    // Attention Red — pulse head only. Body/tail desaturate toward grey.
    headColor: '#ED0C32',
    bodyColorStart: '#D4626F',  // desaturated red
    bodyColorEnd: '#D0D3D7',    // light grey
    tailColor: '#C8CCD0',       // soft grey
    lineWidth: 2,
    // Visible trail spans this many lattice edges (4–6 range, continuous).
    trailLengthEdges: 4,
    // Opacity caps — calm, never neon.
    headOpacity: 0.88,
    bodyOpacity: 0.62,
    tailOpacity: 0.28,
    // Finite lifetime — signals MUST die or activated-edge state grows forever.
    minEdges: 6,
    maxEdges: 12,
  },

  // ---- Signal spawning schedule ------------------------------------------
  spawn: {
    minIntervalMs: 1800,
    maxIntervalMs: 3200,
    // Slightly more concurrent while building — animation is short-lived.
    maxConcurrent: 3,
  },


  // ---- Completed surface appearance -------------------------------------
  surface: {
    // Pause after all four edges close before the top face begins.
    postCompleteDelayMs: 100,
    // Duration of the centre-outward top-face scale-in (easeOutCubic).
    // ~20% slower than prior 700ms for calmer extrusion / deconstruction.
    animDurationMs: 875,
    // Duration of the extrusion rise — begins only after top face finishes.
    // ~20% slower than prior 500ms.
    extrusionDurationMs: 625,
  },

  // ---- Procedural world balance -------------------------------------------
  world: {
    // Working lattice radius — signals, activation, and occupancy stay inside.
    activeCellRadius: 7,
    // Soft targets kept for reference; one-way mode freezes instead of collapsing.
    minOccupancy: 0.22,
    maxOccupancy: 0.35,
    // Ceiling while building toward freeze (must be high enough to hit freezeOccupancy).
    maxCompletedCells: 80,
    // Unused in one-way mode (platforms never deconstruct).
    lifetimeMinMs: 3000,
    lifetimeMaxMs: 5000,
    edgePruneIntervalMs: 800,
    maxActivatedEdges: 64,
  },

  // ---- One-shot lifecycle (client showcase / fixed background) ------------
  // Construction only — no deconstruction. Animate until fill target, then
  // freeze forever as a baked static image (zero ongoing CPU).
  lifecycle: {
    oneWay: true,
    // Freeze when this fraction of working-radius cells are platforms.
    freezeOccupancy: 0.35,
    // Backup cell count (~35% of radius-7 grid ≈ 225 cells).
    freezeAtCells: 70,
    // After freeze: wait for in-flight extrusions to finish rising, then bake.
    settleMs: 1800,
    // Pause when page scroll progress reaches this fraction (0–1).
    // 0.2 = 20% of (document height − viewport). Set null/false to disable.
    scrollPauseAt: 0.20,
    // If true, scrolling back above the threshold resumes the animation.
    // If false, once paused by scroll it stays stopped until occupancy bake.
    scrollResume: true,
  },

  // ---- Runtime performance (fixed absolute background) --------------------
  performance: {
    targetFps: 30,
    drawLatticeNodes: false,
    signalSubdivs: 2,
  },


  // ---- Extrusion height levels (screen pixels) ----------------------------
  // Expressive skyline: mostly low, rare landmarks (weights in simulation).
  heights: [8, 12, 18, 26, 36, 48, 64, 84, 110],
};
