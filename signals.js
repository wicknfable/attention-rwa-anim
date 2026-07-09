/**
 * signals.js
 * ------------------------------------------------------------------------
 * Explorer-signal trail geometry and easing.
 *
 * Signals wander the lattice independently of construction. This module
 * owns only trail math: easing along an edge, polyline trimming, and the
 * draw-ready segment list (uStart/uEnd for the head→tail colour gradient).
 *
 * Simulation owns signal state and edge activation; the renderer only
 * consumes the segments returned here.
 * ------------------------------------------------------------------------
 */

import { Theme } from './theme.js';
import { latticeNodeWorldPosition } from './grid.js';

const EDGE_LENGTH = Theme.grid.spacing;

/** easeInOutQuad — natural acceleration / deceleration along each edge. */
export function easeInOutQuad(t) {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5
    ? 2 * clamped * clamped
    : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
}

function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** Trims a polyline from the head backward to `maxLen` world units. */
function trimPolylineFromHead(points, maxLen) {
  if (points.length < 2) return points;

  const head = points[points.length - 1];
  const result = [head];
  let accumulated = 0;

  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen <= 0) continue;

    if (accumulated + segLen >= maxLen) {
      const remain = maxLen - accumulated;
      const t = 1 - remain / segLen;
      result.unshift({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });
      return result;
    }

    accumulated += segLen;
    result.unshift(a);
  }

  return result;
}

/**
 * Drops oldest trail nodes once the path far exceeds the visible trail length.
 * Mutates `signal.trailNodes` in place.
 */
export function trimSignalTrail(signal) {
  const maxLen = Theme.signal.trailLengthEdges * EDGE_LENGTH * 1.5;
  while (signal.trailNodes.length > 2) {
    const a = latticeNodeWorldPosition(signal.trailNodes[0].i, signal.trailNodes[0].j);
    const b = latticeNodeWorldPosition(signal.trailNodes[1].i, signal.trailNodes[1].j);
    const tailSpan = Math.hypot(b.x - a.x, b.y - a.y);
    if (trailPathLengthWorld(signal.trailNodes) - tailSpan > maxLen) {
      signal.trailNodes.shift();
    } else {
      break;
    }
  }
}

function trailPathLengthWorld(nodes) {
  let len = 0;
  for (let i = 1; i < nodes.length; i++) {
    const a = latticeNodeWorldPosition(nodes[i - 1].i, nodes[i - 1].j);
    const b = latticeNodeWorldPosition(nodes[i].i, nodes[i].j);
    len += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return len;
}

/**
 * Builds the continuous polyline from tail to head, trimmed to the
 * configured trail length, then splits it into draw segments with
 * normalised colour coordinates (0 = tail, 1 = head).
 */
export function buildSignalTrailSegments(signal) {
  const from = latticeNodeWorldPosition(signal.fromNode.i, signal.fromNode.j);
  const to   = latticeNodeWorldPosition(signal.toNode.i,   signal.toNode.j);
  const headT = easeInOutQuad(Math.min(1, signal.progress));

  const head = {
    x: from.x + (to.x - from.x) * headT,
    y: from.y + (to.y - from.y) * headT,
  };

  const polyline = signal.trailNodes.map(n => latticeNodeWorldPosition(n.i, n.j));
  polyline.push(head);

  const maxLen = Theme.signal.trailLengthEdges * EDGE_LENGTH;
  const trimmed = trimPolylineFromHead(polyline, maxLen);
  if (trimmed.length < 2) return [];

  const totalLen = polylineLength(trimmed);
  if (totalLen <= 0) return [];

  const segments = [];
  let walked = 0;

  for (let i = 0; i < trimmed.length - 1; i++) {
    const a = trimmed[i];
    const b = trimmed[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen <= 0) continue;

    const uStart = walked / totalLen;
    const uEnd   = (walked + segLen) / totalLen;
    walked += segLen;

    segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, uStart, uEnd });
  }

  return segments;
}
