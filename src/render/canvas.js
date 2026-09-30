// Canvas drawing only. Reads state, never changes it.

const COLORS = {
  background: '#1b1f1a',
  grid: '#262b25',
  text: '#9aa594',
};

export function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = canvas;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: w, height: h };
}

export function drawEmpty(ctx, width, height, label) {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const step = 32;
  ctx.beginPath();
  for (let x = 0.5; x < width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
  for (let y = 0.5; y < height; y += step) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
  ctx.stroke();

  ctx.fillStyle = COLORS.text;
  ctx.font = '14px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, height / 2);
}
