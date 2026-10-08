// 2D camera: world units are hex radii (see sim/hex.js), scale is screen
// pixels per world unit.

export const MIN_SCALE = 10;
export const MAX_SCALE = 140;
const FIT_MARGIN = 0.95;

export function createCamera() {
  return { x: 0, y: 0, scale: 30 };
}

// Fit world bounds { minX, minY, maxX, maxY } in the view, centered.
export function fitCamera(cam, bounds, width, height) {
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, FIT_MARGIN * Math.min(width / w, height / h)));
  cam.x = bounds.minX + w / 2 - width / cam.scale / 2;
  cam.y = bounds.minY + h / 2 - height / cam.scale / 2;
}

export function toScreen(cam, wx, wy) {
  return { x: (wx - cam.x) * cam.scale, y: (wy - cam.y) * cam.scale };
}

export function toWorld(cam, sx, sy) {
  return { x: sx / cam.scale + cam.x, y: sy / cam.scale + cam.y };
}

// Zoom keeping the world point under (sx, sy) fixed.
export function zoomAt(cam, sx, sy, factor) {
  const before = toWorld(cam, sx, sy);
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, cam.scale * factor));
  cam.x = before.x - sx / cam.scale;
  cam.y = before.y - sy / cam.scale;
}

export function panBy(cam, dxPx, dyPx) {
  cam.x -= dxPx / cam.scale;
  cam.y -= dyPx / cam.scale;
}
