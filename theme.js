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
    // paths are legible without being loud.
    color: '#C5CAD0',
    lineWidth: 1.5,
    // Trails are NOT permanent. After this TTL they fade unless they currently
    // form a completed extrusion boundary (those stay until the platform dies).
    // Short TTL is the main fix for "lattice fills with scars → 5 FPS".
    trailTtlMs: 2800,
    // How often to sweep expired trails (cheap; can run frequently).
    expireCheckMs: 200,
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
    minIntervalMs: 3200,
    maxIntervalMs: 5800,
    // Hard cap — never spawn above this (prevents unbounded signal growth).
    maxConcurrent: 2,
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
    minOccupancy: 0.22,
    maxOccupancy: 0.35,
    // Hard ceiling on simultaneous platforms — fewer = much smoother.
    maxCompletedCells: 12,
    // Each completed platform lives 3–5 s before deconstruction begins.
    lifetimeMinMs: 3000,
    lifetimeMaxMs: 5000,
    // Fallback prune (TTL expiry is the primary cleanup).
    edgePruneIntervalMs: 800,
    // Absolute ceiling on remembered activated edges (draw + GC budget).
    maxActivatedEdges: 48,
  },

  // ---- Runtime performance (fixed absolute background) --------------------
  performance: {
    // 30 FPS is plenty for this ambient layer and halves CPU/GPU work.
    targetFps: 30,
    // Skip drawing lattice nodes (dots) — edges carry the visual language.
    drawLatticeNodes: false,
    // Signal trail subdivisions.
    signalSubdivs: 2,
  },


  // ---- Extrusion height levels (screen pixels) ----------------------------
  // Expressive skyline: mostly low, rare landmarks (weights in simulation).
  heights: [8, 12, 18, 26, 36, 48, 64, 84, 110],
};
