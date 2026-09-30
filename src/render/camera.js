// 2D camera: world units are tiles, scale is screen pixels per tile.

export const MIN_SCALE = 4;
export const MAX_SCALE = 48;

export function createCamera() {
  return { x: 0, y: 0, scale: 10 };
}

// Fit the whole map in the view, centered.
export function fitCamera(cam, map, width, height) {
  cam.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.min(width / map.width, height / map.height)));
  cam.x = map.width / 2 - width / cam.scale / 2;
  cam.y = map.height / 2 - height / cam.scale / 2;
}

export function toScreen(cam, wx, wy) {
  return { x: (wx - cam.x) * cam.scale, y: (wy - cam.y) * cam.scale };
}

export function toWorld(cam, sx, sy) {
  return { x: sx / cam.scale + cam.x, y: sy / cam.scale + cam.y };
}

export function toTile(cam, sx, sy) {
  const w = toWorld(cam, sx, sy);
  return { x: Math.floor(w.x), y: Math.floor(w.y) };
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
