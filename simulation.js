/**
 * simulation.js
 * ------------------------------------------------------------------------
 * Time-based world state for the Attention RWA visualization.
 *
 * Owns (no drawing):
 *   - Explorer signals that wander the lattice and activate edges
 *   - Emergent construction when four edges close a diamond cell
 *   - Extrusion / deconstruction animation phases
 *   - Occupancy balance (lifetime + 40–60% target)
 *   - Foreground-mass deferral so fake-isometric prisms do not collide
 *
 * Signal trail geometry lives in signals.js. The renderer only consumes
 * getDrawData() snapshots.
 * ------------------------------------------------------------------------
 */

import { Theme } from './theme.js';
import { latticeNodeWorldPosition } from './grid.js';
import { trimSignalTrail, buildSignalTrailSegments } from './signals.js';

// ---------------------------------------------------------------------------
// Constants derived from theme — no magic numbers in logic below
// ---------------------------------------------------------------------------

const SIGNAL_SPEED  = Theme.signal.speedWorldPerSec;
const EDGE_LENGTH   = Theme.grid.spacing; // basis vectors have magnitude = spacing
const PROGRESS_PER_MS = SIGNAL_SPEED / (EDGE_LENGTH * 1000); // progress units per ms

const HEIGHT_LEVELS = Theme.heights;

// ---------------------------------------------------------------------------
// Pure lattice topology helpers
// ---------------------------------------------------------------------------

/**
 * Canonical key for the undirected edge between (i1,j1) and (i2,j2).
 * The node whose string representation sorts earlier comes first,
 * guaranteeing the same key regardless of traversal direction.
 */
function edgeKey(i1, j1, i2, j2) {
  const a = `${i1},${j1}`;
  const b = `${i2},${j2}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Parses an edge key back into its two lattice node coordinates. */
function parseEdgeKey(key) {
  const [left, right] = key.split('|');
  const [i1, j1] = left.split(',').map(Number);
  const [i2, j2] = right.split(',').map(Number);
  return { i1, j1, i2, j2 };
}

/** The four directed neighbour offsets from any lattice node. */
const NEIGHBOUR_OFFSETS = [
  { di: +1, dj:  0 },
  { di: -1, dj:  0 },
  { di:  0, dj: +1 },
  { di:  0, dj: -1 },
];

/**
 * The four edge keys that form the boundary of cell (ci, cj).
 * A cell occupies the diamond between lattice nodes:
 *   (ci,cj) → (ci+1,cj) → (ci+1,cj+1) → (ci,cj+1)
 */
function cellEdgeKeys(ci, cj) {
  return [
    edgeKey(ci,   cj,   ci+1, cj  ),  // top-right edge
    edgeKey(ci,   cj,   ci,   cj+1),  // top-left edge
    edgeKey(ci+1, cj,   ci+1, cj+1),  // bottom-right edge
    edgeKey(ci,   cj+1, ci+1, cj+1),  // bottom-left edge
  ];
}

/**
 * Canonical key for a completed cell.
 */
function cellKey(ci, cj) {
  return `${ci},${cj}`;
}

/**
 * World-space coordinates of all four corners of cell (ci, cj).
 * Returned in diamond order: top, right, bottom, left.
 * (These map to lattice nodes: (ci,cj), (ci+1,cj), (ci+1,cj+1), (ci,cj+1))
 */
function cellWorldCorners(ci, cj) {
  return [
    latticeNodeWorldPosition(ci,   cj  ),   // top
    latticeNodeWorldPosition(ci+1, cj  ),   // right
    latticeNodeWorldPosition(ci+1, cj+1),   // bottom
    latticeNodeWorldPosition(ci,   cj+1),   // left
  ];
}

/** Center (world space) of a diamond cell — average of its four corners. */
function cellWorldCenter(corners) {
  return {
    x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) * 0.25,
    y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) * 0.25,
  };
}

// ---------------------------------------------------------------------------
// Easing functions
// ---------------------------------------------------------------------------

/** easeOutCubic — fast start, slow finish. Used for surface scale-in. */
function easeOutCubic(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

/** Maps a pixel height to the nearest discrete level index. */
function nearestHeightIndex(px) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < HEIGHT_LEVELS.length; i++) {
    const dist = Math.abs(HEIGHT_LEVELS[i] - px);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Picks a height index with a low-biased skyline distribution.
 *  Levels: 8, 12, 18, 26, 36, 48, 64, 84, 110
 *  ~45% very low · ~28% low · ~15% medium · ~9% tall · ~3% landmark
 */
function weightedRandomHeightIndex() {
  const roll = Math.random();
  if (roll < 0.45) return Math.floor(Math.random() * 2);       // 8, 12
  if (roll < 0.73) return 2 + Math.floor(Math.random() * 2);   // 18, 26
  if (roll < 0.88) return 4 + Math.floor(Math.random() * 2);   // 36, 48
  if (roll < 0.97) return 6 + Math.floor(Math.random() * 2);   // 64, 84
  return HEIGHT_LEVELS.length - 1;                             // 110
}

// ---------------------------------------------------------------------------
// Union-Find for cluster management
// ---------------------------------------------------------------------------

class UnionFind {
  constructor() {
    this._parent = new Map();
    this._rank   = new Map();
  }

  /** Adds a new element as its own root cluster. */
  add(id) {
    if (!this._parent.has(id)) {
      this._parent.set(id, id);
      this._rank.set(id, 0);
    }
  }

  /** Returns the root ID of the cluster containing `id`. */
  find(id) {
    if (this._parent.get(id) !== id) {
      this._parent.set(id, this.find(this._parent.get(id))); // path compression
    }
    return this._parent.get(id);
  }

  /**
   * Merges the clusters of `a` and `b`. Returns the surviving root ID,
   * or null if they were already in the same cluster.
   */
  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return null;

    // Union by rank keeps the tree shallow.
    if (this._rank.get(rootA) < this._rank.get(rootB)) {
      this._parent.set(rootA, rootB);
      return rootB;
    } else if (this._rank.get(rootA) > this._rank.get(rootB)) {
      this._parent.set(rootB, rootA);
      return rootA;
    } else {
      this._parent.set(rootB, rootA);
      this._rank.set(rootA, this._rank.get(rootA) + 1);
      return rootA;
    }
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export class Simulation {
  constructor() {
    // --- Permanent world state --------------------------------------------

    /** Set of activated edge keys (strings). */
    this.activatedEdgeKeys = new Set();

    /**
     * Map of completed cell key → cell record:
     *   { ci, cj, corners, center, animProgress (0-1), heightLevel }
     */
    this.completedCells = new Map();

    /**
     * Cluster height assignments. Maps the UF root cell key → height index.
     * Height index is 0/1/2 → Theme.heights[index] world units.
     */
    this._clusterHeights = new Map();

    /** Union-Find structure tracking which cells belong to the same cluster. */
    this._uf = new UnionFind();

    // --- Live animation state ---------------------------------------------

    /**
     * Active explorer signals — independent wanderers, not construction agents.
     * Each signal: { fromNode, toNode, progress, prevNodeKey, trailNodes }
     */
    this.signals = [];

    // --- Spawning ---------------------------------------------------------
    this._spawnCooldownMs = 0;
    this._firstSpawnDone  = false;
    this._simTimeMs       = 0;

    /**
     * Cells whose four edges are closed but which were deferred because a
     * completed extrusion already occupies the isometric foreground.
     * Retried whenever a platform collapses and frees the view.
     */
    this._deferredCells = new Set();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Advances the simulation by `deltaMs` milliseconds.
   * Called once per frame from sketch.js.
   */
  update(deltaMs) {
    this._simTimeMs += deltaMs;
    this._trySpawnSignal(deltaMs);
    this._updateSignals(deltaMs);
    this._updateSurfaceAnimations(deltaMs);
    this._checkPlatformLifetimes();
    this._manageWorldOccupancy();
    this._retryDeferredCompletions();
  }

  /**
   * Returns a plain-object snapshot of everything the renderer needs to draw.
   * The renderer should treat this as immutable read-only data.
   *
   * @returns {{
   *   activatedEdges: Array<{x1,y1,x2,y2}>,
   *   signals:        Array<{segments:Array<{x1,y1,x2,y2,uStart,uEnd}>}>,
   *   surfaces:       Array<{corners,center,animScale,extrusionScale,heightPx,ci,cj}>,
   *   interiorEdges:  Array<{x1,y1,x2,y2}>
   * }}
   */
  getDrawData() {
    const activatedEdges = this._buildActivatedEdgeGeometry();
    const signals        = this._buildSignalGeometry();
    const { surfaces, interiorEdges } = this._buildSurfaceGeometry();
    return { activatedEdges, signals, surfaces, interiorEdges };
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  _trySpawnSignal(deltaMs) {
    if (!this._firstSpawnDone) {
      for (let i = 0; i < 3; i++) this._spawnSignal();
      this._firstSpawnDone = true;
      this._resetSpawnCooldown();
      return;
    }

    this._spawnCooldownMs -= deltaMs;

    const minConcurrent = 4;
    if (this.signals.length < minConcurrent || this._spawnCooldownMs <= 0) {
      this._spawnSignal();
      this._resetSpawnCooldown();
    }
  }

  _resetSpawnCooldown() {
    const { minIntervalMs, maxIntervalMs } = Theme.spawn;
    this._spawnCooldownMs = minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
  }

  /**
   * Spawns an independent explorer signal at a random lattice node.
   * Signals wander freely — construction is never an explicit goal.
   */
  _spawnSignal() {
    const range = 8;
    const si = Math.floor((Math.random() - 0.5) * range * 2);
    const sj = Math.floor((Math.random() - 0.5) * range * 2);

    const offsets = [...NEIGHBOUR_OFFSETS].sort(() => Math.random() - 0.5);
    const firstNeighbour = offsets[0];

    this.signals.push({
      fromNode:    { i: si, j: sj },
      toNode:      { i: si + firstNeighbour.di, j: sj + firstNeighbour.dj },
      progress:    0,
      prevNodeKey: cellKey(si, sj),
      trailNodes:  [{ i: si, j: sj }],
    });
  }

  // -------------------------------------------------------------------------
  // Signal update
  // -------------------------------------------------------------------------

  _updateSignals(deltaMs) {
    const nextSignals = [];

    for (const signal of this.signals) {
      const progressDelta = PROGRESS_PER_MS * deltaMs;
      signal.progress += progressDelta;

      if (signal.progress >= 1) {
        this._activateEdge(signal.fromNode, signal.toNode);

        const nextEdge = this._chooseNextEdge(signal.toNode, signal.fromNode);
        if (!nextEdge) continue;

        signal.trailNodes.push({ ...signal.toNode });
        trimSignalTrail(signal);

        signal.prevNodeKey = cellKey(signal.fromNode.i, signal.fromNode.j);
        signal.fromNode    = { ...signal.toNode };
        signal.toNode      = nextEdge;
        signal.progress    = signal.progress - 1;
      }

      nextSignals.push(signal);
    }

    this.signals = nextSignals;
  }

  /**
   * Picks a random connected edge to wander along.
   * Prefers fresh edges when available; never targets construction.
   */
  _chooseNextEdge(currentNode, prevNode) {
    const { i, j } = currentNode;
    const unactivated = [];
    const activated   = [];

    for (const { di, dj } of NEIGHBOUR_OFFSETS) {
      const ni = i + di;
      const nj = j + dj;
      if (ni === prevNode.i && nj === prevNode.j) continue;

      const key = edgeKey(i, j, ni, nj);
      (this.activatedEdgeKeys.has(key) ? activated : unactivated).push({ i: ni, j: nj });
    }

    const pool = unactivated.length > 0 ? unactivated : activated;
    if (pool.length === 0) return null;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  // -------------------------------------------------------------------------
  // Edge activation & cell detection
  // -------------------------------------------------------------------------

  _activateEdge(fromNode, toNode) {
    const key = edgeKey(fromNode.i, fromNode.j, toNode.i, toNode.j);
    if (this.activatedEdgeKeys.has(key)) return;

    this.activatedEdgeKeys.add(key);

    // Check whether activating this edge completes any diamond cells.
    // The cells that could be completed by this edge depend on which
    // direction the edge runs:
    //
    //   u-direction edge (i,j)→(i+1,j):  could complete cells (i,j) and (i,j-1)
    //   v-direction edge (i,j)→(i,j+1):  could complete cells (i,j) and (i-1,j)
    //
    // Rather than special-casing direction, we check all cells that share
    // any of the four edges at either endpoint — simpler and still O(1).
    const cellsToCheck = this._cellsAdjacentToEdge(fromNode, toNode);
    for (const [ci, cj] of cellsToCheck) {
      this._checkAndCompleteCell(ci, cj);
    }
  }

  /**
   * Returns the (at most 2) cells that share the given edge.
   * Each lattice edge borders exactly two cells except at the boundary
   * of a finite region, where it borders one.
   */
  _cellsAdjacentToEdge(a, b) {
    // Determine edge direction: u-direction or v-direction.
    const di = b.i - a.i;
    const dj = b.j - a.j;

    // Normalise so (a) is always the "lower" endpoint.
    const minI = Math.min(a.i, b.i);
    const minJ = Math.min(a.j, b.j);

    if (di !== 0) {
      // u-direction edge: (minI, minJ) → (minI+1, minJ)
      // Adjacent cells: (minI, minJ) and (minI, minJ-1)
      return [[minI, minJ], [minI, minJ - 1]];
    } else {
      // v-direction edge: (minI, minJ) → (minI, minJ+1)
      // Adjacent cells: (minI, minJ) and (minI-1, minJ)
      return [[minI, minJ], [minI - 1, minJ]];
    }
  }

  /** Checks if all four edges of cell (ci,cj) are activated; if so, completes it. */
  _checkAndCompleteCell(ci, cj) {
    const key = cellKey(ci, cj);
    if (this.completedCells.has(key)) return;

    const edges = cellEdgeKeys(ci, cj);
    const allActive = edges.every(e => this.activatedEdgeKeys.has(e));
    if (!allActive) {
      this._deferredCells.delete(key);
      return;
    }

    // -----------------------------------------------------------------
    // Foreground occupancy — ROOT CAUSE of incorrect visual overlap:
    //
    // Depth-sorting alone cannot fix fake isometric extrusions. A platform
    // built BEHIND an existing foreground mass still paints side faces that
    // intersect the nearer prism in screen space, because vertical lift is
    // a 2D offset, not true 3D occlusion.
    //
    // Treat completed extrusions as solid architectural mass. If any
    // non-collapsing platform already sits in the isometric foreground of
    // this cell (toward the viewer / higher world depth), defer construction
    // and let signals keep exploring elsewhere. Retry when that mass clears.
    // -----------------------------------------------------------------
    if (this._hasForegroundMass(ci, cj)) {
      this._deferredCells.add(key);
      return;
    }

    this._deferredCells.delete(key);

    // Cell is complete — create the surface record.
    const corners = cellWorldCorners(ci, cj);
    const center  = cellWorldCenter(corners);

    // Register with union-find and assign/inherit cluster height.
    this._uf.add(key);
    let heightPx = this._pickHeightForCell(ci, cj);

    // Check adjacent completed cells; merge clusters if found.
    const adjacentOffsets = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dci, dcj] of adjacentOffsets) {
      const adjKey = cellKey(ci + dci, cj + dcj);
      const adjCell = this.completedCells.get(adjKey);
      if (!adjCell || this._isCollapsing(adjCell)) continue;

      const survivingRoot = this._uf.union(key, adjKey);
      if (survivingRoot) {
        const existingRoot = this._uf.find(adjKey);
        heightPx = this._clusterHeights.get(existingRoot) ?? heightPx;
        this._clusterHeights.set(survivingRoot, heightPx);
      }
    }

    // Ensure the root's height is set (handles the no-adjacent-cells case).
    const myRoot = this._uf.find(key);
    if (!this._clusterHeights.has(myRoot)) {
      this._clusterHeights.set(myRoot, heightPx);
    }

    this.completedCells.set(key, {
      ci, cj,
      corners,
      center,
      phase: 'delay',
      phaseTimer: 0,
      surfaceProgress: 0,
      extrusionProgress: 0,
      heightPx: this._clusterHeights.get(myRoot),
      completedAt: this._simTimeMs,
    });
  }

  /**
   * Returns true when a completed extrusion already occupies the isometric
   * foreground of cell (ci, cj).
   *
   * Viewing direction: toward increasing world-Y / depthKey. On this lattice
   * that corresponds to increasing (i + j) — the diamond's "bottom" tip faces
   * the viewer. Any solid mass in that front cone would incorrectly intersect
   * a new extrusion painted behind it.
   */
  _hasForegroundMass(ci, cj) {
    const myDepth = ci + cj;

    // Front-facing offsets: toward the viewer along the isometric depth axis.
    // Includes the immediate front neighbours and one step further so a tall
    // mass two cells ahead still blocks construction behind it.
    const frontOffsets = [
      [1, 0], [0, 1], [1, 1],
      [2, 0], [0, 2], [2, 1], [1, 2], [2, 2],
    ];

    for (const [di, dj] of frontOffsets) {
      const oci = ci + di;
      const ocj = cj + dj;
      if (oci + ocj <= myDepth) continue;

      const other = this.completedCells.get(cellKey(oci, ocj));
      if (!other || this._isCollapsing(other)) continue;
      if (other.surfaceProgress <= 0) continue;

      return true;
    }

    return false;
  }

  /** Retries cells deferred by foreground occupancy once the view may be clear. */
  _retryDeferredCompletions() {
    if (this._deferredCells.size === 0) return;

    const pending = [...this._deferredCells];
    for (const key of pending) {
      const [ci, cj] = key.split(',').map(Number);
      this._checkAndCompleteCell(ci, cj);
    }
  }

  /**
   * Chooses a discrete height for a new cell. Isolated cells use a
   * weighted low-biased distribution; cells near neighbours inherit
   * similar heights with small local variation.
   */
  _pickHeightForCell(ci, cj) {
    const neighborHeights = [];
    const adjacentOffsets = [[1,0],[-1,0],[0,1],[0,-1]];

    for (const [dci, dcj] of adjacentOffsets) {
      const adj = this.completedCells.get(cellKey(ci + dci, cj + dcj));
      if (adj && !this._isCollapsing(adj)) {
        neighborHeights.push(adj.heightPx);
      }
    }

    if (neighborHeights.length === 0) {
      return HEIGHT_LEVELS[weightedRandomHeightIndex()];
    }

    const avgPx = neighborHeights.reduce((sum, h) => sum + h, 0) / neighborHeights.length;
    let index = nearestHeightIndex(avgPx);

    const roll = Math.random();
    if (roll < 0.55) {
      // Stay at the same band as neighbours.
    } else if (roll < 0.85) {
      index += Math.random() < 0.5 ? -1 : 1;
    } else {
      index += Math.random() < 0.5 ? -2 : 2;
    }

    index = Math.max(0, Math.min(HEIGHT_LEVELS.length - 1, index));
    return HEIGHT_LEVELS[index];
  }

  _isCollapsing(cell) {
    return cell.phase === 'collapseExtrusion' || cell.phase === 'collapseSurface';
  }

  // -------------------------------------------------------------------------
  // Surface animation
  // -------------------------------------------------------------------------

  _updateSurfaceAnimations(deltaMs) {
    const {
      postCompleteDelayMs,
      animDurationMs,
      extrusionDurationMs,
    } = Theme.surface;

    for (const cell of this.completedCells.values()) {
      switch (cell.phase) {
        case 'delay':
          cell.phaseTimer += deltaMs;
          if (cell.phaseTimer >= postCompleteDelayMs) {
            cell.phase = 'surface';
            cell.phaseTimer = 0;
          }
          break;

        case 'surface':
          cell.surfaceProgress = Math.min(1, cell.surfaceProgress + deltaMs / animDurationMs);
          if (cell.surfaceProgress >= 1) {
            cell.phase = 'extrusion';
          }
          break;

        case 'extrusion':
          cell.extrusionProgress = Math.min(1, cell.extrusionProgress + deltaMs / extrusionDurationMs);
          if (cell.extrusionProgress >= 1) {
            cell.phase = 'done';
            cell.completedAt = this._simTimeMs;
            const { lifetimeMinMs, lifetimeMaxMs } = Theme.world;
            cell.expiresAt = this._simTimeMs + lifetimeMinMs +
              Math.random() * (lifetimeMaxMs - lifetimeMinMs);
          }
          break;

        case 'collapseExtrusion':
          cell.extrusionProgress = Math.max(0, cell.extrusionProgress - deltaMs / extrusionDurationMs);
          if (cell.extrusionProgress <= 0) {
            cell.phase = 'collapseSurface';
          }
          break;

        case 'collapseSurface':
          cell.surfaceProgress = Math.max(0, cell.surfaceProgress - deltaMs / animDurationMs);
          if (cell.surfaceProgress <= 0) {
            this._finalizeCollapse(cell);
          }
          break;

        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Procedural world balance — maintain 40–60 % occupancy indefinitely
  // -------------------------------------------------------------------------

  _checkPlatformLifetimes() {
    for (const cell of this.completedCells.values()) {
      if (cell.phase !== 'done') continue;
      if (cell.expiresAt == null || this._simTimeMs < cell.expiresAt) continue;
      this._beginCollapse(cell);
      return;
    }
  }

  _beginCollapse(cell) {
    if (this._isCollapsing(cell)) return;
    cell.phase = 'collapseExtrusion';
  }

  _computeOccupancy() {
    const R = Theme.world.activeCellRadius;
    let total = 0;
    let occupied = 0;

    for (let ci = -R; ci <= R; ci++) {
      for (let cj = -R; cj <= R; cj++) {
        total++;
        const cell = this.completedCells.get(cellKey(ci, cj));
        if (cell && !this._isCollapsing(cell)) {
          occupied++;
        }
      }
    }

    return total > 0 ? occupied / total : 0;
  }

  _manageWorldOccupancy() {
    const occupancy = this._computeOccupancy();
    if (occupancy <= Theme.world.maxOccupancy) return;

    const candidates = [];
    for (const cell of this.completedCells.values()) {
      if (cell.phase === 'done') candidates.push(cell);
    }
    if (candidates.length === 0) return;

    candidates.sort((a, b) => a.completedAt - b.completedAt);
    const pickFrom = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.35)));
    this._beginCollapse(pickFrom[Math.floor(Math.random() * pickFrom.length)]);
  }

  _finalizeCollapse(cell) {
    const key = cellKey(cell.ci, cell.cj);
    this.completedCells.delete(key);

    for (const eKey of cellEdgeKeys(cell.ci, cell.cj)) {
      if (!this._edgeRequiredByCompletedCell(eKey)) {
        this.activatedEdgeKeys.delete(eKey);
      }
    }

    const root = this._uf.find(key);
    let clusterHasCells = false;
    for (const otherKey of this.completedCells.keys()) {
      if (this._uf.find(otherKey) === root) {
        clusterHasCells = true;
        break;
      }
    }
    if (!clusterHasCells) {
      this._clusterHeights.delete(root);
    }

    this._retryDeferredCompletions();
  }

  /** True when any remaining completed cell shares this edge on its boundary. */
  _edgeRequiredByCompletedCell(eKey) {
    const { i1, j1, i2, j2 } = parseEdgeKey(eKey);

    const cellsToCheck = [];
    const di = i2 - i1;
    const dj = j2 - j1;
    const minI = Math.min(i1, i2);
    const minJ = Math.min(j1, j2);

    if (di !== 0) {
      cellsToCheck.push([minI, minJ], [minI, minJ - 1]);
    } else {
      cellsToCheck.push([minI, minJ], [minI - 1, minJ]);
    }

    for (const [ci, cj] of cellsToCheck) {
      if (this.completedCells.has(cellKey(ci, cj))) {
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Draw data construction
  // -------------------------------------------------------------------------

  _buildActivatedEdgeGeometry() {
    const result = [];
    for (const key of this.activatedEdgeKeys) {
      const { i1, j1, i2, j2 } = parseEdgeKey(key);
      const a = latticeNodeWorldPosition(i1, j1);
      const b = latticeNodeWorldPosition(i2, j2);
      result.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    }
    return result;
  }

  _buildSignalGeometry() {
    return this.signals.map(signal => ({
      segments: buildSignalTrailSegments(signal),
    }));
  }

  _buildSurfaceGeometry() {
    const surfaces      = [];
    const interiorEdges = [];
    const seenInterior = new Set();

    for (const cell of this.completedCells.values()) {
      const animScale      = easeOutCubic(cell.surfaceProgress);
      const extrusionScale = easeOutCubic(cell.extrusionProgress);

      surfaces.push({
        corners:        cell.corners,
        center:         cell.center,
        animScale,
        extrusionScale,
        heightPx:       cell.heightPx,
        ci:             cell.ci,
        cj:             cell.cj,
      });

      if (animScale < 0.98) continue;

      const { ci, cj } = cell;
      const adjacentOffsets = [[1,0],[-1,0],[0,1],[0,-1]];

      for (const [dci, dcj] of adjacentOffsets) {
        const adjKey = cellKey(ci + dci, cj + dcj);
        const adjCell = this.completedCells.get(adjKey);
        if (!adjCell || easeOutCubic(adjCell.surfaceProgress) < 0.98) continue;

        let eKey;
        if (dci === 1) {
          eKey = edgeKey(ci+1, cj, ci+1, cj+1);
        } else if (dci === -1) {
          eKey = edgeKey(ci, cj, ci, cj+1);
        } else if (dcj === 1) {
          eKey = edgeKey(ci, cj+1, ci+1, cj+1);
        } else {
          eKey = edgeKey(ci, cj, ci+1, cj);
        }

        if (!seenInterior.has(eKey)) {
          seenInterior.add(eKey);
          const { i1, j1, i2, j2 } = parseEdgeKey(eKey);
          const a = latticeNodeWorldPosition(i1, j1);
          const b = latticeNodeWorldPosition(i2, j2);
          interiorEdges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
      }
    }

    return { surfaces, interiorEdges };
  }
}
