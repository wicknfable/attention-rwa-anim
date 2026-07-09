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
import { latticeNodeWorldPosition, latticeEdgeKey } from './grid.js';
import { trimSignalTrail, buildSignalTrailSegments } from './signals.js';

// ---------------------------------------------------------------------------
// Constants derived from theme — no magic numbers in logic below
// ---------------------------------------------------------------------------

const SIGNAL_SPEED  = Theme.signal.speedWorldPerSec;
const EDGE_LENGTH   = Theme.grid.spacing; // basis vectors have magnitude = spacing
const PROGRESS_PER_MS = SIGNAL_SPEED / (EDGE_LENGTH * 1000); // progress units per ms

const HEIGHT_LEVELS = Theme.heights;
const EMPTY_ACTIVATED = [];

// ---------------------------------------------------------------------------
// Pure lattice topology helpers
// ---------------------------------------------------------------------------

/**
 * Canonical key for the undirected edge between (i1,j1) and (i2,j2).
 * The node whose string representation sorts earlier comes first,
 * guaranteeing the same key regardless of traversal direction.
 */
function edgeKey(i1, j1, i2, j2) {
  return latticeEdgeKey(i1, j1, i2, j2);
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

  /** Removes a leaf element that is no longer in the world. */
  remove(id) {
    this._parent.delete(id);
    this._rank.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export class Simulation {
  constructor() {
    // --- Permanent world state --------------------------------------------

    /**
     * Activated lattice edges left by explorer signals.
     * NOT permanent scars — each edge carries an expiry timestamp.
     * Map: edgeKey → { x1,y1,x2,y2, key, expiresAt }
     */
    this.activatedEdges = new Map();

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
    this._edgePruneTimerMs = 0;
    this._edgeExpireTimerMs = 0;
    this._occupancyTimerMs = 0;

    /**
     * Cells whose four edges are closed but which were deferred because a
     * completed extrusion already occupies the isometric foreground.
     * Retried whenever a platform collapses and frees the view.
     */
    this._deferredCells = new Set();

    // --- Draw-data caches (avoid per-frame allocation storms) --------------
    this._activatedEdgeList = [];
    this._drawSurfaces = [];
    this._drawInteriorEdges = [];
    this._drawPartialSurfaces = [];
    this._drawOccludedKeys = new Set();
    this._drawSignals = [];
    this._seenInterior = new Set();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Advances the simulation by `deltaMs` milliseconds.
   * Called once per frame from sketch.js.
   */
  update(deltaMs) {
    // Clamp huge frame gaps (tab resume) so simulation doesn't explode.
    const dt = Math.min(deltaMs, 50);

    this._simTimeMs += dt;
    this._trySpawnSignal(dt);
    this._updateSignals(dt);
    this._updateSurfaceAnimations(dt);
    this._checkPlatformLifetimes();

    this._occupancyTimerMs += dt;
    if (this._occupancyTimerMs >= 400) {
      this._occupancyTimerMs = 0;
      this._manageWorldOccupancy();
      this._retryDeferredCompletions();
    }

    // Primary cleanup: trails die after trailTtlMs unless pinning a platform.
    this._edgeExpireTimerMs += dt;
    if (this._edgeExpireTimerMs >= (Theme.activatedEdge.expireCheckMs || 200)) {
      this._edgeExpireTimerMs = 0;
      this._expireActivatedEdges();
    }

    this._edgePruneTimerMs += dt;
    if (this._edgePruneTimerMs >= Theme.world.edgePruneIntervalMs) {
      this._edgePruneTimerMs = 0;
      this._pruneActivatedEdges();
    }
  }

  /**
   * Returns a plain-object snapshot of everything the renderer needs to draw.
   * The renderer should treat this as immutable read-only data.
   *
   * @returns {{
   *   activatedEdges: Array<{x1,y1,x2,y2,key}>,
   *   signals:        Array<{segments:Array}>,
   *   surfaces:       Array,
   *   interiorEdges:  Array,
   *   occludedEdgeKeys: Set<string>,
   *   partialSurfaces: Array
   * }}
   */
  getDrawData() {
    const drawScars = Theme.activatedEdge.drawScars !== false;
    return {
      // Empty when scars are hidden — skip drawing + projection cost.
      activatedEdges: drawScars ? this._buildActivatedEdgeGeometry() : EMPTY_ACTIVATED,
      signals:        this._buildSignalGeometry(),
      ...this._buildSurfaceGeometry(),
    };
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  _trySpawnSignal(deltaMs) {
    const maxConcurrent = Theme.spawn.maxConcurrent;

    if (!this._firstSpawnDone) {
      const initial = Math.min(2, maxConcurrent);
      for (let i = 0; i < initial; i++) this._spawnSignal();
      this._firstSpawnDone = true;
      this._resetSpawnCooldown();
      return;
    }

    this._spawnCooldownMs -= deltaMs;

    // Only spawn when under the hard cap AND the cooldown has elapsed.
    // (Previously cooldown alone could spawn forever → unbounded signals.)
    if (this._spawnCooldownMs <= 0 && this.signals.length < maxConcurrent) {
      this._spawnSignal();
      this._resetSpawnCooldown();
    } else if (this._spawnCooldownMs <= 0) {
      this._resetSpawnCooldown();
    }
  }

  _resetSpawnCooldown() {
    const { minIntervalMs, maxIntervalMs } = Theme.spawn;
    this._spawnCooldownMs = minIntervalMs + Math.random() * (maxIntervalMs - minIntervalMs);
  }

  /**
   * Spawns an independent explorer signal inside the working lattice radius.
   */
  _spawnSignal() {
    if (this.signals.length >= Theme.spawn.maxConcurrent) return;

    const range = Theme.world.activeCellRadius;
    const si = Math.floor((Math.random() - 0.5) * range * 2);
    const sj = Math.floor((Math.random() - 0.5) * range * 2);

    const offsets = [...NEIGHBOUR_OFFSETS].sort(() => Math.random() - 0.5);
    const firstNeighbour = offsets[0];

    const maxEdges = Theme.signal.minEdges +
      Math.floor(Math.random() * (Theme.signal.maxEdges - Theme.signal.minEdges + 1));

    this.signals.push({
      fromNode:       { i: si, j: sj },
      toNode:         { i: si + firstNeighbour.di, j: sj + firstNeighbour.dj },
      progress:       0,
      edgesTraversed: 0,
      maxEdges,
      prevNodeKey:    cellKey(si, sj),
      trailNodes:     [{ i: si, j: sj }],
    });
  }

  // -------------------------------------------------------------------------
  // Signal update
  // -------------------------------------------------------------------------

  _updateSignals(deltaMs) {
    const nextSignals = [];
    const R = Theme.world.activeCellRadius;

    for (const signal of this.signals) {
      const progressDelta = PROGRESS_PER_MS * deltaMs;
      signal.progress += progressDelta;

      if (signal.progress >= 1) {
        this._activateEdge(signal.fromNode, signal.toNode);
        signal.edgesTraversed++;

        if (signal.edgesTraversed >= signal.maxEdges) {
          continue; // retire — finite lifetime prevents unbounded growth
        }

        const nextEdge = this._chooseNextEdge(signal.toNode, signal.fromNode);
        if (!nextEdge) continue;

        // Soft wall: retire if the signal drifts outside the working radius.
        if (Math.abs(nextEdge.i) > R || Math.abs(nextEdge.j) > R) {
          continue;
        }

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
      (this.activatedEdges.has(key) ? activated : unactivated).push({ i: ni, j: nj });
    }

    const pool = unactivated.length > 0 ? unactivated : activated;
    if (pool.length === 0) return null;

    return pool[Math.floor(Math.random() * pool.length)];
  }

  // -------------------------------------------------------------------------
  // Edge activation & cell detection
  // -------------------------------------------------------------------------

  _activateEdge(fromNode, toNode) {
    const R = Theme.world.activeCellRadius;
    // Never record edges outside the working radius — infinite lattice leak.
    if (Math.abs(fromNode.i) > R || Math.abs(fromNode.j) > R ||
        Math.abs(toNode.i) > R || Math.abs(toNode.j) > R) {
      return;
    }

    const key = edgeKey(fromNode.i, fromNode.j, toNode.i, toNode.j);
    const ttl = Theme.activatedEdge.trailTtlMs || 2800;
    const expiresAt = this._simTimeMs + ttl;

    const existing = this.activatedEdges.get(key);
    if (existing) {
      // Refresh TTL so recently-travelled trails stay visible / completable.
      existing.expiresAt = expiresAt;
    } else {
      // Hard budget — drop a random expired-eligible edge before growing.
      const maxEdges = Theme.world.maxActivatedEdges || 48;
      if (this.activatedEdges.size >= maxEdges) {
        this._dropOldestExpirableEdge();
      }

      const a = latticeNodeWorldPosition(fromNode.i, fromNode.j);
      const b = latticeNodeWorldPosition(toNode.i, toNode.j);
      this.activatedEdges.set(key, {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, key, expiresAt,
      });
    }

    const cellsToCheck = this._cellsAdjacentToEdge(fromNode, toNode);
    for (const [ci, cj] of cellsToCheck) {
      this._checkAndCompleteCell(ci, cj);
    }
  }

  /** Removes one trail that is not currently pinning a completed cell. */
  _dropOldestExpirableEdge() {
    let oldestKey = null;
    let oldestExp = Infinity;
    for (const [key, edge] of this.activatedEdges) {
      if (this._edgeRequiredByCompletedCell(key)) continue;
      if (edge.expiresAt < oldestExp) {
        oldestExp = edge.expiresAt;
        oldestKey = key;
      }
    }
    if (oldestKey) this.activatedEdges.delete(oldestKey);
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
    const R = Theme.world.activeCellRadius;
    if (Math.abs(ci) > R || Math.abs(cj) > R) return;

    const key = cellKey(ci, cj);
    if (this.completedCells.has(key)) return;

    // Hard ceiling — refuse new construction when at budget.
    if (this.completedCells.size >= Theme.world.maxCompletedCells) {
      this._deferredCells.add(key);
      return;
    }

    const edges = cellEdgeKeys(ci, cj);
    const allActive = edges.every(e => this.activatedEdges.has(e));
    if (!allActive) {
      this._deferredCells.delete(key);
      return;
    }

    if (this._hasForegroundMass(ci, cj)) {
      this._deferredCells.add(key);
      return;
    }

    this._deferredCells.delete(key);

    const corners = cellWorldCorners(ci, cj);
    const center  = cellWorldCenter(corners);

    this._uf.add(key);
    let heightPx = this._pickHeightForCell(ci, cj);

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

    // Pin boundary edges for the platform's life — TTL expiry must not
    // dissolve a closed diamond while the extrusion is still standing.
    const pinUntil = this._simTimeMs + (Theme.world.lifetimeMaxMs || 5000) + 4000;
    for (const eKey of edges) {
      const edge = this.activatedEdges.get(eKey);
      if (edge && edge.expiresAt < pinUntil) edge.expiresAt = pinUntil;
    }
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
    // Collapse up to 2 expired platforms per frame so backlog clears quickly.
    let collapsed = 0;
    for (const cell of this.completedCells.values()) {
      if (cell.phase !== 'done') continue;
      if (cell.expiresAt == null || this._simTimeMs < cell.expiresAt) continue;
      this._beginCollapse(cell);
      collapsed++;
      if (collapsed >= 2) return;
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
    const overCap = this.completedCells.size > Theme.world.maxCompletedCells;
    const occupancy = this._computeOccupancy();
    if (!overCap && occupancy <= Theme.world.maxOccupancy) return;

    const candidates = [];
    for (const cell of this.completedCells.values()) {
      if (cell.phase === 'done') candidates.push(cell);
    }
    if (candidates.length === 0) return;

    // Prefer oldest — no full sort; pick from a small sample of earliest.
    let oldest = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      if (candidates[i].completedAt < oldest.completedAt) oldest = candidates[i];
    }
    this._beginCollapse(oldest);

    // If still over hard cap, collapse one more immediately.
    if (this.completedCells.size > Theme.world.maxCompletedCells) {
      let second = null;
      for (const cell of this.completedCells.values()) {
        if (cell.phase !== 'done' || cell === oldest) continue;
        if (!second || cell.completedAt < second.completedAt) second = cell;
      }
      if (second) this._beginCollapse(second);
    }
  }

  /**
   * Primary cleanup: drop trails whose TTL elapsed, unless they currently
   * form the boundary of a live extrusion. This is what stops the lattice
   * filling with permanent scars and killing frame rate.
   */
  _expireActivatedEdges() {
    const now = this._simTimeMs;
    const toDelete = [];

    for (const [key, edge] of this.activatedEdges) {
      if (edge.expiresAt > now) continue;
      // Keep edges that still pin a completed/collapsing platform.
      if (this._edgeRequiredByCompletedCell(key)) {
        // Stretch expiry so we don't re-check as often while pinned.
        edge.expiresAt = now + 1000;
        continue;
      }
      toDelete.push(key);
    }

    for (const key of toDelete) {
      this.activatedEdges.delete(key);
    }
  }

  /**
   * Secondary cleanup: radius + hard budget. TTL expiry does most of the work.
   */
  _pruneActivatedEdges() {
    const R = Theme.world.activeCellRadius;
    const keep = new Set();

    for (const cell of this.completedCells.values()) {
      for (const eKey of cellEdgeKeys(cell.ci, cell.cj)) {
        keep.add(eKey);
      }
    }

    for (const signal of this.signals) {
      const nodes = signal.trailNodes;
      for (let i = 1; i < nodes.length; i++) {
        keep.add(edgeKey(nodes[i - 1].i, nodes[i - 1].j, nodes[i].i, nodes[i].j));
      }
      keep.add(edgeKey(
        signal.fromNode.i, signal.fromNode.j,
        signal.toNode.i, signal.toNode.j
      ));
    }

    for (const key of this.activatedEdges.keys()) {
      if (keep.has(key)) continue;

      const { i1, j1, i2, j2 } = parseEdgeKey(key);
      const outside =
        Math.abs(i1) > R || Math.abs(j1) > R ||
        Math.abs(i2) > R || Math.abs(j2) > R;

      if (outside) {
        this.activatedEdges.delete(key);
      }
    }

    if (this._deferredCells.size > 32) {
      this._deferredCells.clear();
    }

    const maxEdges = Theme.world.maxActivatedEdges || 48;
    if (this.activatedEdges.size > maxEdges) {
      const excess = this.activatedEdges.size - maxEdges;
      let dropped = 0;
      // Prefer dropping soonest-to-expire unpinned edges.
      const candidates = [];
      for (const [key, edge] of this.activatedEdges) {
        if (keep.has(key)) continue;
        candidates.push({ key, expiresAt: edge.expiresAt });
      }
      candidates.sort((a, b) => a.expiresAt - b.expiresAt);
      for (let i = 0; i < candidates.length && dropped < excess; i++) {
        this.activatedEdges.delete(candidates[i].key);
        dropped++;
      }
    }
  }

  _finalizeCollapse(cell) {
    const key = cellKey(cell.ci, cell.cj);
    this.completedCells.delete(key);

    // Platform gone — drop its boundary trails immediately so the lattice
    // returns to its clean original state (no lingering scars).
    for (const eKey of cellEdgeKeys(cell.ci, cell.cj)) {
      if (!this._edgeRequiredByCompletedCell(eKey)) {
        this.activatedEdges.delete(eKey);
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

    this._uf.remove(key);
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
    const result = this._activatedEdgeList;
    result.length = 0;
    for (const geom of this.activatedEdges.values()) {
      result.push(geom);
    }
    return result;
  }

  _buildSignalGeometry() {
    const out = this._drawSignals;
    out.length = 0;
    for (let i = 0; i < this.signals.length; i++) {
      out.push({ segments: buildSignalTrailSegments(this.signals[i]) });
    }
    return out;
  }

  _buildSurfaceGeometry() {
    const surfaces = this._drawSurfaces;
    const interiorEdges = this._drawInteriorEdges;
    const partialSurfaces = this._drawPartialSurfaces;
    const occludedEdgeKeys = this._drawOccludedKeys;
    const seenInterior = this._seenInterior;

    surfaces.length = 0;
    interiorEdges.length = 0;
    partialSurfaces.length = 0;
    occludedEdgeKeys.clear();
    seenInterior.clear();

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

      if (animScale <= 0) continue;

      if (animScale >= 0.98) {
        for (const eKey of cellEdgeKeys(cell.ci, cell.cj)) {
          occludedEdgeKeys.add(eKey);
        }
      } else {
        partialSurfaces.push({
          corners: cell.corners,
          center:  cell.center,
          animScale,
        });
      }

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
          const geom = this.activatedEdges.get(eKey);
          if (geom) {
            interiorEdges.push(geom);
          } else {
            const { i1, j1, i2, j2 } = parseEdgeKey(eKey);
            const a = latticeNodeWorldPosition(i1, j1);
            const b = latticeNodeWorldPosition(i2, j2);
            interiorEdges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
          }
        }
      }
    }

    return { surfaces, interiorEdges, occludedEdgeKeys, partialSurfaces };
  }
}
