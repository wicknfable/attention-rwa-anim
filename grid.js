/**
 * grid.js
 * ------------------------------------------------------------------------
 * Isometric lattice generation only.
 *
 * Basis vectors from Theme.grid.isoAngleDegrees / spacing project integer
 * (i, j) lattice coordinates into world space. generateLatticeData() covers
 * the camera's visible world bounds (plus overscan). latticeNodeWorldPosition
 * is the shared projection used by simulation and signals.
 * ------------------------------------------------------------------------
 */

import { Theme } from './theme.js';

/**
 * Builds the two basis vectors for the isometric lattice from the
 * configured angle and spacing. Using basis vectors (rather than ad-hoc
 * trig scattered through the codebase) means the whole lattice can be
 * reprojected just by changing these two vectors.
 */
function buildBasis() {
  const angleRad = (Theme.grid.isoAngleDegrees * Math.PI) / 180;
  const spacing = Theme.grid.spacing;

  // Two symmetric directions mirrored across the vertical axis. This is
  // the standard construction for a 30°-isometric diamond lattice.
  const basisU = { x: Math.cos(angleRad) * spacing, y: Math.sin(angleRad) * spacing };
  const basisV = { x: -Math.cos(angleRad) * spacing, y: Math.sin(angleRad) * spacing };

  return { basisU, basisV };
}

const { basisU, basisV } = buildBasis();

/** Projects lattice coordinates (i, j) into world space. */
function latticeToWorld(i, j) {
  return {
    x: i * basisU.x + j * basisV.x,
    y: i * basisU.y + j * basisV.y,
  };
}

/**
 * Inverts the basis matrix so we can figure out which (i, j) range
 * covers a given world-space bounding box. Solves:
 *   worldX = i*ux + j*vx
 *   worldY = i*uy + j*vy
 */
function worldToLattice(worldX, worldY) {
  const det = basisU.x * basisV.y - basisV.x * basisU.y;
  const i = (worldX * basisV.y - worldY * basisV.x) / det;
  const j = (worldY * basisU.x - worldX * basisU.y) / det;
  return { i, j };
}

/**
 * Computes the full set of lattice nodes and edges needed to cover the
 * given world-space bounds. Returns plain data, ready for the renderer
 * to draw and depth-shade.
 *
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} worldBounds
 * @returns {{ nodes: Array<{i:number,j:number,x:number,y:number}>,
 *             edges: Array<{x1:number,y1:number,x2:number,y2:number}> }}
 */
export function generateLatticeData(worldBounds) {
  // Find the (i, j) lattice-coordinate range spanning all four corners
  // of the world-space bounding box, then pad by one to avoid clipped
  // edges at the boundary.
  const corners = [
    worldToLattice(worldBounds.minX, worldBounds.minY),
    worldToLattice(worldBounds.maxX, worldBounds.minY),
    worldToLattice(worldBounds.minX, worldBounds.maxY),
    worldToLattice(worldBounds.maxX, worldBounds.maxY),
  ];

  let minI = Infinity, maxI = -Infinity, minJ = Infinity, maxJ = -Infinity;
  for (const c of corners) {
    minI = Math.min(minI, c.i);
    maxI = Math.max(maxI, c.i);
    minJ = Math.min(minJ, c.j);
    maxJ = Math.max(maxJ, c.j);
  }
  minI = Math.floor(minI) - 1;
  maxI = Math.ceil(maxI) + 1;
  minJ = Math.floor(minJ) - 1;
  maxJ = Math.ceil(maxJ) + 1;

  const nodes = [];
  // Pre-allocate a lookup grid (as a Map) so edge generation can reuse
  // already-computed world positions instead of recomputing them.
  const positionLookup = new Map();

  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const p = latticeToWorld(i, j);
      positionLookup.set(`${i},${j}`, p);
      nodes.push({ i, j, x: p.x, y: p.y });
    }
  }

  // Edges connect each node to its neighbour along +i and +j only.
  // This yields every lattice edge exactly once (no duplicates).
  const edges = [];
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const here = positionLookup.get(`${i},${j}`);

      const right = positionLookup.get(`${i + 1},${j}`);
      if (right) edges.push({ x1: here.x, y1: here.y, x2: right.x, y2: right.y });

      const down = positionLookup.get(`${i},${j + 1}`);
      if (down) edges.push({ x1: here.x, y1: here.y, x2: down.x, y2: down.y });
    }
  }

  return { nodes, edges };
}

/**
 * Exported projection helper so other modules (e.g. simulation.js) can
 * convert lattice coordinates to world space using the same basis vectors
 * that the grid generation uses. Single source of truth for the projection.
 */
export function latticeNodeWorldPosition(i, j) {
  return latticeToWorld(i, j);
}
