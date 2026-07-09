/**
 * renderer.js
 * ------------------------------------------------------------------------
 * All drawing for the Attention RWA lattice.
 *
 * Responsibilities:
 *   1. Atmospheric depth fade on inactive lattice (screen-space Y)
 *   2. Footprint clipping — ground edges never draw under solid mass
 *   3. Painter's algorithm for extrusions (world Y, back → front)
 *   4. Signal trails with platform occlusion
 *
 * Render order (simulation layer):
 *   activated edges → completed extrusions → travelling signals
 * ------------------------------------------------------------------------
 */

import { Theme } from './theme.js';

/**
 * Smoothstep-style easing. Produces a gentle S-curve instead of a linear
 * ramp, so the fade feels atmospheric rather than mechanical.
 */
function easeSmooth(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Computes the depth-fade factor (0-1) for a given screen-space Y
 * position. 0 = most faded (top of fade band), 1 = fully crisp.
 *
 * This is the single source of truth for "how far into the atmosphere"
 * a screen point is — both opacity and scale derive from it, so they
 * stay visually consistent with each other.
 */
function depthFactorForScreenY(screenY, viewportHeight) {
  const fadeBandPx = viewportHeight * Theme.depth.fadeBandHeight;
  if (fadeBandPx <= 0) return 1;

  // t = 0 at the very top of the viewport, t = 1 at the bottom of the
  // fade band (and beyond — geometry below the band is fully crisp).
  const t = screenY / fadeBandPx;
  return easeSmooth(t);
}

function opacityForDepthFactor(depthFactor) {
  const { minOpacity, maxOpacity } = Theme.depth;
  return minOpacity + (maxOpacity - minOpacity) * depthFactor;
}

function scaleForDepthFactor(depthFactor) {
  const { minScale } = Theme.depth;
  return minScale + (1 - minScale) * depthFactor;
}

/** Linearly interpolates between two [r,g,b] triplets. */
function lerpRgb(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/** Returns [r,g,b,alpha] for a position u within the travelling pulse (0=tail, 1=head). */
function pulseColorAt(u, headRgb, bodyStartRgb, bodyEndRgb, tailRgb, theme) {
  const { headOpacity, bodyOpacity, tailOpacity } = theme.signal;
  let rgb;
  let alpha;

  if (u >= 0.72) {
    // HEAD — bright Attention Red, highest opacity.
    const t = (u - 0.72) / 0.28;
    const desaturated = lerpRgb(headRgb, bodyStartRgb, 0.15);
    rgb = lerpRgb(desaturated, headRgb, t);
    alpha = bodyOpacity + (headOpacity - bodyOpacity) * t;
  } else if (u >= 0.28) {
    // BODY — desaturated red toward light grey.
    const t = (u - 0.28) / 0.44;
    rgb = lerpRgb(bodyStartRgb, bodyEndRgb, t);
    alpha = tailOpacity + (bodyOpacity - tailOpacity) * t;
  } else {
    // TAIL — soft grey, gradually desaturating into transparency.
    const t = u / 0.28;
    const grey = lerpRgb(tailRgb, bodyEndRgb, t * 0.4);
    rgb = lerpRgb(bodyEndRgb, grey, 1 - t);
    alpha = tailOpacity * t;
  }

  return [rgb[0], rgb[1], rgb[2], alpha];
}

/** Fast point-in-polygon (ray cast only — no boundary distance). */
function pointInPolygonFast(px, py, verts) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Point-in-polygon test (ray casting). Boundary points count as inside. */
function pointInPolygon(px, py, verts) {
  // Treat vertices / near-boundary as inside so footprint perimeter edges cull.
  const EPS = 0.75;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    if (distPointToSegment(px, py, verts[j].x, verts[j].y, verts[i].x, verts[i].y) <= EPS) {
      return true;
    }
  }
  return pointInPolygonFast(px, py, verts);
}

/** Distance from point to segment AB. */
function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Intersection parameter t in [0,1] for segment P1→P2 against segment A→B.
 * Returns null if no proper intersection.
 */
function segmentIntersectionT(p1, p2, a, b) {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;

  const qx = a.x - p1.x;
  const qy = a.y - p1.y;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return Math.max(0, Math.min(1, t));
}

/**
 * Clips segment P1→P2 against one convex footprint.
 * Returns sub-segments that lie STRICTLY OUTSIDE the footprint
 * (portions beneath solid mass are discarded).
 */
function clipSegmentOutsidePolygon(p1, p2, poly) {
  const ts = [0, 1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const t = segmentIntersectionT(p1, p2, poly[j], poly[i]);
    if (t != null && t > 1e-6 && t < 1 - 1e-6) ts.push(t);
  }
  ts.sort((a, b) => a - b);

  const outside = [];
  for (let i = 0; i < ts.length - 1; i++) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-6) continue;

    const mx = p1.x + (p2.x - p1.x) * (t0 + t1) * 0.5;
    const my = p1.y + (p2.y - p1.y) * (t0 + t1) * 0.5;
    if (pointInPolygon(mx, my, poly)) continue;

    outside.push({
      x1: p1.x + (p2.x - p1.x) * t0,
      y1: p1.y + (p2.y - p1.y) * t0,
      x2: p1.x + (p2.x - p1.x) * t1,
      y2: p1.y + (p2.y - p1.y) * t1,
    });
  }
  return outside;
}

/** Parses a "#RRGGBB" hex string into an [r, g, b] array. */
function hexToRgb(hex) {
  const value = hex.replace('#', '');
  return [
    parseInt(value.substring(0, 2), 16),
    parseInt(value.substring(2, 4), 16),
    parseInt(value.substring(4, 6), 16),
  ];
}

/** Empty shared constants — avoid allocating new Set/Array every frame. */
const EMPTY_SET = new Set();
const EMPTY_ARR = [];

export class Renderer {
  /**
   * @param {import('p5')} p  The active p5 instance (instance mode).
   */
  constructor(p) {
    this.p = p;

    // Cache parsed RGB values so we don't re-parse hex strings every
    // frame for every primitive.
    this.gridLineRgb       = hexToRgb(Theme.color.gridLine);
    this.nodeRgb           = hexToRgb(Theme.color.node);
    this.backgroundRgb     = hexToRgb(Theme.color.background);
    this.activatedEdgeRgb  = hexToRgb(Theme.activatedEdge.color);
    this.surfaceRgb        = hexToRgb(Theme.color.futureSurface);
    this.leftFaceRgb       = hexToRgb(Theme.color.futureLeftFace);
    this.rightFaceRgb      = hexToRgb(Theme.color.futureRightFace);
    this.signalHeadRgb     = hexToRgb(Theme.signal.headColor);
    this.signalBodyStartRgb = hexToRgb(Theme.signal.bodyColorStart);
    this.signalBodyEndRgb   = hexToRgb(Theme.signal.bodyColorEnd);
    this.signalTailRgb      = hexToRgb(Theme.signal.tailColor);

    // Reusable scratch buffers — avoid per-frame GC in the hot path.
    this._footprints = [];
    this._sortedSurfaces = [];
    this._occluders = [];
    this._bandBuckets = null;
    this._bandStyles = null;

    // Offscreen lattice layer — redrawn only when occlusion set changes.
    /** @type {import('p5').Graphics | null} */
    this._latticeGfx = null;
    this._latticeGfxKey = '';
    this._latticeGfxW = 0;
    this._latticeGfxH = 0;
  }

  /** Clears the canvas to the background colour. */
  clearBackground() {
    const [r, g, b] = this.backgroundRgb;
    this.p.background(r, g, b);
  }

  /**
   * Draws the inactive lattice from a pre-projected screen-space cache.
   * Rasterized once per resize into an offscreen buffer, then blitted.
   * Fully expanded platforms paint opaque footprints on top, so we do not
   * rebuild this layer when occlusion changes (that was causing hitch spikes).
   *
   * @param {{ edges: Array, nodes: Array, bandCount: number }} screenLattice
   * @param {{ occludedEdgeKeys?: Set<string> }} [_occlusion]  unused — kept for API compat
   */
  renderScreenLattice(screenLattice, _occlusion = {}) {
    const w = this.p.width;
    const h = this.p.height;
    const cacheKey = `${w}x${h}|${screenLattice.edges.length}|${screenLattice.bandCount}`;

    if (
      !this._latticeGfx ||
      this._latticeGfxW !== w ||
      this._latticeGfxH !== h ||
      this._latticeGfxKey !== cacheKey
    ) {
      this._rebuildLatticeLayer(screenLattice, w, h, cacheKey);
    }

    this.clearBackground();
    this.p.image(this._latticeGfx, 0, 0);
  }

  /** Rasterizes the inactive lattice into `_latticeGfx` (resize / first frame only). */
  _rebuildLatticeLayer(screenLattice, w, h, cacheKey) {
    if (!this._latticeGfx || this._latticeGfxW !== w || this._latticeGfxH !== h) {
      this._latticeGfx = this.p.createGraphics(w, h);
      this._latticeGfx.pixelDensity(1);
      this._latticeGfxW = w;
      this._latticeGfxH = h;
    }

    const g = this._latticeGfx;
    g.clear();

    const bandCount = screenLattice.bandCount || Theme.grid.depthBands || 6;
    this._ensureBandStyles(bandCount);

    const buckets = this._bandBuckets;
    for (let i = 0; i < bandCount; i++) buckets[i].length = 0;

    for (const edge of screenLattice.edges) {
      buckets[edge.band].push(edge);
    }

    const [r, gc, b] = this.gridLineRgb;
    g.noFill();

    for (let band = 0; band < bandCount; band++) {
      const list = buckets[band];
      if (list.length === 0) continue;
      const style = this._bandStyles[band];
      g.stroke(r, gc, b, style.alpha);
      g.strokeWeight(style.weight);
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        g.line(e.x1, e.y1, e.x2, e.y2);
      }
    }

    if (Theme.performance?.drawLatticeNodes && screenLattice.nodes.length > 0) {
      const [nr, ng, nb] = this.nodeRgb;
      const baseSize = Theme.grid.nodeSize;
      g.noStroke();
      g.rectMode(g.CENTER);
      for (const node of screenLattice.nodes) {
        const style = this._bandStyles[node.band];
        g.fill(nr, ng, nb, style.alpha);
        g.rect(node.x, node.y, baseSize * style.scale, baseSize * style.scale);
      }
    }

    this._latticeGfxKey = cacheKey;
  }

  /** Precomputes per-band stroke alpha/weight so the lattice draw batches. */
  _ensureBandStyles(bandCount) {
    if (this._bandStyles && this._bandStyles.length === bandCount) return;

    this._bandBuckets = Array.from({ length: bandCount }, () => []);
    this._bandStyles = [];
    const baseWeight = Theme.grid.lineWidth;

    for (let i = 0; i < bandCount; i++) {
      const depth = (i + 0.5) / bandCount;
      this._bandStyles.push({
        alpha: opacityForDepthFactor(depth) * 255,
        weight: baseWeight * scaleForDepthFactor(depth),
        scale: scaleForDepthFactor(depth),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Simulation layer — called from sketch.js after render(), so these always
  // draw on top of the inactive lattice in the correct order:
  //   activated edges → completed extrusions (painter's algorithm) → signals
  // The renderer does not know why edges are activated or why surfaces exist.
  // It only knows what to draw and where.
  // -------------------------------------------------------------------------

  /**
   * Draws everything produced by the Simulation system.
   * Must be called after render() each frame.
   *
   * @param {Camera} camera
   * @param {{ activatedEdges, signals, surfaces, interiorEdges }} simDrawData
   */
  drawSimulation(camera, simDrawData) {
    const vh = camera.viewportHeight;
    const occluded = simDrawData.occludedEdgeKeys || EMPTY_SET;
    // Partial footprints are rare (only cells mid scale-in). Skip clip work
    // entirely when none exist — the common case once the world fills.
    const partials = simDrawData.partialSurfaces || EMPTY_ARR;
    const partialFootprints = partials.length > 0
      ? this._buildExtrusionFootprints(partials)
      : EMPTY_ARR;

    // Activated "scars" are optional. Default off so the lattice stays clean —
    // only the live pulse + extrusions read as lasting marks.
    if (Theme.activatedEdge.drawScars !== false) {
      this._drawActivatedEdges(
        simDrawData.activatedEdges, camera, vh, occluded, partialFootprints
      );
    }

    this._drawSurfaces(simDrawData.surfaces, simDrawData.interiorEdges, camera, vh);
    this._drawSignals(simDrawData.signals, simDrawData.surfaces, camera, vh);
  }

  /**
   * World-space footprints of completed extrusions (scaled diamonds).
   * Used to clip ground-plane lattice / activated edges so they never
   * continue beneath solid architectural mass.
   */
  _buildExtrusionFootprints(surfaces) {
    const footprints = this._footprints;
    footprints.length = 0;

    for (const surface of surfaces) {
      if (surface.animScale < 0.02) continue;

      const cx = surface.center.x;
      const cy = surface.center.y;
      const s  = surface.animScale;

      footprints.push(surface.corners.map(c => ({
        x: cx + (c.x - cx) * s,
        y: cy + (c.y - cy) * s,
      })));
    }

    return footprints;
  }

  /**
   * Clips a world-space edge against every completed footprint.
   * Returns the visible exterior segments only — nothing under solid mass.
   */
  _clipEdgeAgainstFootprints(x1, y1, x2, y2, footprints) {
    let segments = [{ x1, y1, x2, y2 }];

    for (const fp of footprints) {
      const next = [];
      for (const seg of segments) {
        const clipped = clipSegmentOutsidePolygon(
          { x: seg.x1, y: seg.y1 },
          { x: seg.x2, y: seg.y2 },
          fp
        );
        for (const c of clipped) next.push(c);
      }
      segments = next;
      if (segments.length === 0) break;
    }

    return segments;
  }

  /** Activated edges — Set-cull fully hidden; clip only against scaling footprints. */
  _drawActivatedEdges(edges, camera, viewportHeight, occluded = EMPTY_SET, partialFootprints = EMPTY_ARR) {
    const p = this.p;
    const [r, g, b] = this.activatedEdgeRgb;
    const baseWeight = Theme.activatedEdge.lineWidth;

    // Batch: one stroke setup, then all lines. Depth variation is subtle on
    // activated paths — use a single mid-band style to cut p5 state churn.
    const midDepth = 0.65;
    const alpha = opacityForDepthFactor(midDepth) * 255;
    const weight = baseWeight * scaleForDepthFactor(midDepth);

    p.noFill();
    p.stroke(r, g, b, alpha);
    p.strokeWeight(weight);

    const hasPartials = partialFootprints.length > 0;

    for (const edge of edges) {
      if (edge.key && occluded.has(edge.key)) continue;

      if (hasPartials) {
        const segments = this._clipEdgeAgainstFootprints(
          edge.x1, edge.y1, edge.x2, edge.y2, partialFootprints
        );
        for (const seg of segments) {
          const a  = camera.worldToScreen(seg.x1, seg.y1);
          const b_ = camera.worldToScreen(seg.x2, seg.y2);
          p.line(a.x, a.y, b_.x, b_.y);
        }
      } else {
        const a  = camera.worldToScreen(edge.x1, edge.y1);
        const b_ = camera.worldToScreen(edge.x2, edge.y2);
        p.line(a.x, a.y, b_.x, b_.y);
      }
    }
  }

  /**
   * Construction signals: continuous multi-edge trail. Segments behind solid
   * platforms are occluded so signals never bleed through completed geometry.
   */
  _drawSignals(signals, surfaces, camera, viewportHeight) {
    const p = this.p;
    const baseWeight = Theme.signal.lineWidth;
    const headRgb  = this.signalHeadRgb;
    const bodyStart = this.signalBodyStartRgb;
    const bodyEnd   = this.signalBodyEndRgb;
    const tailRgb   = this.signalTailRgb;
    const SUBDIVS   = Theme.performance?.signalSubdivs ?? 2;
    const OPAQUE = 255;

    // AABB-only occluders — point-in-polygon against every platform per
    // subdiv was O(signals × subdivs × platforms) and caused the fill stutter.
    const occluders = this._buildPlatformOccluders(surfaces, camera);

    p.noFill();
    for (const signal of signals) {
      for (const seg of signal.segments) {
        const from = camera.worldToScreen(seg.x1, seg.y1);
        const to   = camera.worldToScreen(seg.x2, seg.y2);

        const midY   = (from.y + to.y) * 0.5;
        const depth  = depthFactorForScreenY(midY, viewportHeight);
        const depthAlpha = opacityForDepthFactor(depth);
        const weight = baseWeight * scaleForDepthFactor(depth);

        p.strokeWeight(weight);

        for (let i = 0; i < SUBDIVS; i++) {
          const t0 = i / SUBDIVS;
          const t1 = (i + 1) / SUBDIVS;
          const u  = seg.uStart + (seg.uEnd - seg.uStart) * (t0 + t1) * 0.5;

          const x0 = from.x + (to.x - from.x) * t0;
          const y0 = from.y + (to.y - from.y) * t0;
          const x1 = from.x + (to.x - from.x) * t1;
          const y1 = from.y + (to.y - from.y) * t1;

          const midX = (x0 + x1) * 0.5;
          const midSegY = (y0 + y1) * 0.5;
          if (this._isOccludedByPlatform(midX, midSegY, occluders)) continue;

          const [r, g, b, a] = pulseColorAt(u, headRgb, bodyStart, bodyEnd, tailRgb, Theme);
          const alpha = a * depthAlpha * OPAQUE;
          if (alpha < 1) continue;

          p.stroke(r, g, b, alpha);
          p.line(x0, y0, x1, y1);
        }
      }
    }
  }

  /**
   * Screen-space AABB volumes for signal occlusion.
   * Footprint polygon tests were too expensive once many platforms exist;
   * diamond AABBs are slightly conservative but visually fine for trails.
   */
  _buildPlatformOccluders(surfaces, camera) {
    const occluders = this._occluders;
    occluders.length = 0;

    for (const surface of surfaces) {
      if (surface.animScale < 0.85) continue;

      const s = surface.animScale;
      const cx = surface.center.x;
      const cy = surface.center.y;
      let minWX = Infinity, maxWX = -Infinity, minWY = Infinity, maxWY = -Infinity;
      for (const c of surface.corners) {
        const x = cx + (c.x - cx) * s;
        const y = cy + (c.y - cy) * s;
        if (x < minWX) minWX = x;
        if (x > maxWX) maxWX = x;
        if (y < minWY) minWY = y;
        if (y > maxWY) maxWY = y;
      }

      const tl = camera.worldToScreen(minWX, minWY);
      const br = camera.worldToScreen(maxWX, maxWY);
      const extrudePx = surface.heightPx * surface.extrusionScale;
      const minX = Math.min(tl.x, br.x);
      const maxX = Math.max(tl.x, br.x);
      const maxY = Math.max(tl.y, br.y);
      const topY = Math.min(tl.y, br.y) - extrudePx;

      occluders.push({ minX, maxX, minY: topY, maxY, topY });
    }

    return occluders;
  }

  /** True when a screen point lies inside a solid platform AABB below its top. */
  _isOccludedByPlatform(x, y, occluders) {
    for (let i = 0; i < occluders.length; i++) {
      const occ = occluders[i];
      if (x < occ.minX || x > occ.maxX || y < occ.minY || y > occ.maxY) continue;
      if (y >= occ.topY - 1) return true;
    }
    return false;
  }

  /**
   * Completed diamond cells: top face rises upward from the lattice; side
   * faces connect the elevated top back to the fixed ground plane.
   * Architectural geometry is always fully opaque — no atmospheric fade.
   *
   * Painter's algorithm (isometric depth sort) — every frame:
   * -----------------------------------------------------------------
   * DEPTH KEY: world-space center.y  (ascending = back → front)
   *
   * Why world Y, not creation order / surface id / center.x+center.y:
   *
   *   Lattice basis: U = (cos θ, sin θ), V = (−cos θ, sin θ).
   *   Screen Y increases with world Y, so larger world Y sits lower on
   *   screen — that is the isometric FOREGROUND (toward the viewer).
   *   Smaller world Y sits higher on screen — the BACKGROUND.
   *
   *   Sorting by center.x + center.y is incorrect for this projection.
   *   Horizontal world X is mixed into the key, so a back-left cell can
   *   sort after a front-right cell and paint over nearer geometry.
   *   Pure world Y is proportional to (i + j) on this lattice and is the
   *   classic isometric depth axis for a diamond grid.
   *
   *   Construction / Map insertion order must never affect overlap.
   *   The sort is recomputed from world positions every frame.
   *
   * Secondary key: center.x ascending — stable tie-break for cells that
   * share the same depth row (same i+j) and do not visually occlude.
   * -----------------------------------------------------------------
   */
  _drawSurfaces(surfaces, interiorEdges, camera, viewportHeight) {
    const p = this.p;
    const [sr, sg, sb] = this.surfaceRgb;
    const [lr, lg, lb] = this.leftFaceRgb;
    const [rr, rg, rb] = this.rightFaceRgb;
    const OPAQUE = 255;

    p.noStroke();
    p.blendMode(p.BLEND);

    // Painter's algorithm: furthest (smallest world Y) first, nearest last.
    const sorted = this._sortedSurfaces;
    sorted.length = 0;
    for (let i = 0; i < surfaces.length; i++) sorted.push(surfaces[i]);
    sorted.sort((a, b) => {
      const dy = a.center.y - b.center.y;
      if (dy !== 0) return dy;
      return a.center.x - b.center.x;
    });

    // Scratch verts reused across surfaces — avoid 3× map() allocations each.
    const fp = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ];
    const top = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ];

    for (const surface of sorted) {
      if (surface.animScale <= 0 && surface.extrusionScale <= 0) continue;

      const baseCenter = camera.worldToScreen(surface.center.x, surface.center.y);
      const s = surface.animScale;

      for (let i = 0; i < 4; i++) {
        const c = surface.corners[i];
        const sc = camera.worldToScreen(c.x, c.y);
        fp[i].x = baseCenter.x + (sc.x - baseCenter.x) * s;
        fp[i].y = baseCenter.y + (sc.y - baseCenter.y) * s;
      }

      const extrudePx = surface.heightPx * surface.extrusionScale;
      for (let i = 0; i < 4; i++) {
        top[i].x = fp[i].x;
        top[i].y = fp[i].y - extrudePx;
      }

      // Solid footprint occludes lattice beneath the platform mass.
      if (surface.animScale > 0) {
        p.fill(sr, sg, sb, OPAQUE);
        p.beginShape();
        for (let i = 0; i < 4; i++) p.vertex(fp[i].x, fp[i].y);
        p.endShape(p.CLOSE);
      }

      // Visible walls: front-left (3–2) and front-right (1–2).
      if (surface.extrusionScale > 0) {
        p.fill(lr, lg, lb, OPAQUE);
        p.beginShape();
        p.vertex(fp[3].x, fp[3].y);
        p.vertex(fp[2].x, fp[2].y);
        p.vertex(top[2].x, top[2].y);
        p.vertex(top[3].x, top[3].y);
        p.endShape(p.CLOSE);

        p.fill(rr, rg, rb, OPAQUE);
        p.beginShape();
        p.vertex(fp[1].x, fp[1].y);
        p.vertex(fp[2].x, fp[2].y);
        p.vertex(top[2].x, top[2].y);
        p.vertex(top[1].x, top[1].y);
        p.endShape(p.CLOSE);

        p.fill(sr, sg, sb, OPAQUE);
        p.beginShape();
        for (let i = 0; i < 4; i++) p.vertex(top[i].x, top[i].y);
        p.endShape(p.CLOSE);
      }
    }

    if (interiorEdges.length === 0) return;

    p.noFill();
    p.strokeWeight(3);

    for (const edge of interiorEdges) {
      const a  = camera.worldToScreen(edge.x1, edge.y1);
      const b_ = camera.worldToScreen(edge.x2, edge.y2);
      p.stroke(sr, sg, sb, OPAQUE);
      p.line(a.x, a.y, b_.x, b_.y);
    }
  }
}
