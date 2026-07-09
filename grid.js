/**
 * grid.js
 * ------------------------------------------------------------------------
 * Isometric lattice generation only.
 *
 * Basis vectors from Theme.grid.isoAngleDegrees / spacing project integer
 * (i, j) lattice coordinates into world space. generateLatticeData() covers
 * the camera's visible world bounds (plus overscan). latticeNodeWorldPosition
 * is the shared projection used by simulation and signals.
 *
 * Results are cached by integer (i,j) range so a stable camera does not
 * rebuild thousands of nodes/edges every frame.
 * ------------------------------------------------------------------------
 */

import { Theme } from './theme.js';

function buildBasis() {
  const angleRad = (Theme.grid.isoAngleDegrees * Math.PI) / 180;
  const spacing = Theme.grid.spacing;

  const basisU = { x: Math.cos(angleRad) * spacing, y: Math.sin(angleRad) * spacing };
  const basisV = { x: -Math.cos(angleRad) * spacing, y: Math.sin(angleRad) * spacing };

  return { basisU, basisV };
}

const { basisU, basisV } = buildBasis();

/** @type {{ key: string, data: { nodes: Array, edges: Array } } | null} */
let _latticeCache = null;

function latticeToWorld(i, j) {
  return {
    x: i * basisU.x + j * basisV.x,
    y: i * basisU.y + j * basisV.y,
  };
}

function worldToLattice(worldX, worldY) {
  const det = basisU.x * basisV.y - basisV.x * basisU.y;
  const i = (worldX * basisV.y - worldY * basisV.x) / det;
  const j = (worldY * basisU.x - worldX * basisU.y) / det;
  return { i, j };
}

/**
 * Canonical undirected edge key — shared with simulation occlusion sets.
 */
export function latticeEdgeKey(i1, j1, i2, j2) {
  const a = `${i1},${j1}`;
  const b = `${i2},${j2}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * @param {{minX:number,maxX:number,minY:number,maxY:number}} worldBounds
 * @returns {{ nodes: Array, edges: Array<{x1,y1,x2,y2,i1,j1,i2,j2,key}> }}
 */
export function generateLatticeData(worldBounds) {
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

  const cacheKey = `${minI},${maxI},${minJ},${maxJ}`;
  if (_latticeCache && _latticeCache.key === cacheKey) {
    return _latticeCache.data;
  }

  const nodes = [];
  const positionLookup = new Map();

  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const p = latticeToWorld(i, j);
      positionLookup.set(`${i},${j}`, p);
      nodes.push({ i, j, x: p.x, y: p.y });
    }
  }

  const edges = [];
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      const here = positionLookup.get(`${i},${j}`);

      const right = positionLookup.get(`${i + 1},${j}`);
      if (right) {
        edges.push({
          x1: here.x, y1: here.y, x2: right.x, y2: right.y,
          i1: i, j1: j, i2: i + 1, j2: j,
          key: latticeEdgeKey(i, j, i + 1, j),
        });
      }

      const down = positionLookup.get(`${i},${j + 1}`);
      if (down) {
        edges.push({
          x1: here.x, y1: here.y, x2: down.x, y2: down.y,
          i1: i, j1: j, i2: i, j2: j + 1,
          key: latticeEdgeKey(i, j, i, j + 1),
        });
      }
    }
  }

  const data = { nodes, edges };
  _latticeCache = { key: cacheKey, data };
  return data;
}

export function latticeNodeWorldPosition(i, j) {
  return latticeToWorld(i, j);
}
