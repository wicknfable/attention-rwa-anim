/**
 * camera.js
 * ------------------------------------------------------------------------
 * Minimal 2D camera: world ↔ screen projection for the isometric lattice.
 *
 * World space  — infinite lattice coordinates (basis from grid.js)
 * Screen space — canvas pixels; camera (x, y) maps to viewport centre
 *
 * All drawing systems ask the Camera for projection so pan/zoom can change
 * without touching the grid or renderer.
 * ------------------------------------------------------------------------
 */

export class Camera {
  /**
   * @param {number} x     World-space x of the point the camera looks at.
   * @param {number} y     World-space y of the point the camera looks at.
   * @param {number} zoom  Scale multiplier applied to world space.
   */
  constructor(x = 0, y = 0, zoom = 1) {
    this.x = x;
    this.y = y;
    this.zoom = zoom;
    this.viewportWidth = 0;
    this.viewportHeight = 0;

    // Reused for getVisibleWorldBounds to avoid per-frame allocation.
    this._bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  }

  /** Call whenever the canvas size changes. */
  resize(width, height) {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /**
   * Converts a world-space point to a screen-space pixel position.
   * The camera's (x, y) is always mapped to the center of the viewport.
   */
  worldToScreen(worldX, worldY) {
    return {
      x: this.viewportWidth * 0.5 + (worldX - this.x) * this.zoom,
      y: this.viewportHeight * 0.5 + (worldY - this.y) * this.zoom,
    };
  }

  /**
   * Writes world→screen into an existing `{x,y}` object (hot-path friendly).
   * @param {{x:number,y:number}} out
   */
  worldToScreenInto(worldX, worldY, out) {
    out.x = this.viewportWidth * 0.5 + (worldX - this.x) * this.zoom;
    out.y = this.viewportHeight * 0.5 + (worldY - this.y) * this.zoom;
    return out;
  }

  /**
   * Converts a screen-space pixel position back to world space.
   */
  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.viewportWidth * 0.5) / this.zoom + this.x,
      y: (screenY - this.viewportHeight * 0.5) / this.zoom + this.y,
    };
  }

  /**
   * World-space bounding box currently visible on screen, expanded by
   * `overscanFactor`. Mutates and returns an internal buffer — callers
   * must not retain the reference across frames.
   */
  getVisibleWorldBounds(overscanFactor = 1) {
    const halfW = (this.viewportWidth * 0.5) / this.zoom * overscanFactor;
    const halfH = (this.viewportHeight * 0.5) / this.zoom * overscanFactor;
    const b = this._bounds;
    b.minX = this.x - halfW;
    b.maxX = this.x + halfW;
    b.minY = this.y - halfH;
    b.maxY = this.y + halfH;
    return b;
  }
}
