// Presentation constants for the renderer. Gameplay numbers live in
// data/balance.json, not here.

export const COLORS = {
  paper: '#E8E5DA',
  ground: '#D9D5C4',
  grid: 'rgba(21, 24, 26, 0.10)',
  ink: '#15181A',
  inkMuted: '#4A4D46',
  friendly: '#80E0FF',
  suppressed: '#F2B33D',
  pinned: '#8E1B12',
  pinnedInk: '#FFFFFF',
  hatch: 'rgba(21, 24, 26, 0.28)',
  fire: '#1F3F8F',
  fireInk: '#FFFFFF',
  fireTile: 'rgba(255, 255, 255, 0.35)',
};

export const FONT = "'Barlow Condensed', 'Arial Narrow', sans-serif";

// Map-scale team counter, in CSS pixels.
export const COUNTER = {
  w: 66,
  h: 44,
  stroke: 2.5,
  echelonSize: 14,
  echelonGap: 3,
  letterSize: 22,
  letterGap: 6,
  pip: 7,
  pipStroke: 1.5,
  pipGap: 2,
  pipGroupGap: 7,
  pipTop: 8,
  hatchSpacing: 7,
  hatchWidth: 2,
  badge: {
    w: 32,
    suppressedH: 22,
    pinnedH: 28,
    stroke: 2,
    radius: 4,
    // Badge's right edge sits this far past the frame's right edge,
    // and its bottom this far below the frame's top edge.
    overhangX: 18,
    dropY: 8,
  },
};

export const FIRE_MARKER = {
  size: 40,
  stroke: 2.5,
  lineWidth: 2.5,
  dash: [10, 7],
  tagSize: 16,
};
