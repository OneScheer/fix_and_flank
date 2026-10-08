// Movement animation along hex centers. No DOM, so it can be tested.

// Position after `t` hexes of travel along points[0..n]. t is clamped to
// [0, n]: a frame's timestamp can be slightly earlier than the moment the
// move was confirmed, which would otherwise give a negative t.
export function positionAlong(points, t) {
  const n = points.length - 1;
  if (n <= 0) return points[0];
  const c = Math.min(n, Math.max(0, t));
  if (c === n) return points[n];
  const i = Math.floor(c);
  const f = c - i;
  return { x: points[i].x + (points[i + 1].x - points[i].x) * f, y: points[i].y + (points[i + 1].y - points[i].y) * f };
}
