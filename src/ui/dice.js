// The dice tray: shows a roll over the map, the dice tumbling for a moment
// before they settle on the values the sim rolled. Display only: the faces
// shown while tumbling are random and mean nothing; the settled faces are
// the real dice.

const PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};
const TUMBLE_EVERY_MS = 70;

function die() {
  const d = document.createElement('span');
  d.className = 'die';
  for (let i = 0; i < 9; i++) d.append(document.createElement('i'));
  return d;
}

function face(d, value) {
  const on = new Set(PIPS[value]);
  [...d.children].forEach((pip, i) => pip.classList.toggle('on', on.has(i)));
}

export function createDiceTray(el) {
  let timers = [];
  const clear = () => {
    timers.forEach((t) => clearTimeout(t) || clearInterval(t));
    timers = [];
  };

  // spec: { title, rows: [{ label, values, need, note }], result, rollMs, staggerMs }
  // A row with no values shows its note instead (e.g. "pinned: cannot shoot back").
  function show(spec) {
    clear();
    el.replaceChildren();
    el.hidden = false;
    el.classList.remove('settled');
    const title = document.createElement('div');
    title.className = 'dice-title';
    title.textContent = spec.title;
    el.append(title);
    const all = [];
    spec.rows.forEach((row, r) => {
      const line = document.createElement('div');
      line.className = 'dice-row';
      const label = document.createElement('span');
      label.className = 'dice-label';
      label.textContent = row.label;
      line.append(label);
      if (!row.values.length) {
        const note = document.createElement('span');
        note.className = 'dice-note';
        note.textContent = row.note ?? '';
        line.append(note);
      }
      const dice = row.values.map(() => die());
      line.append(...dice);
      el.append(line);
      dice.forEach((d, i) => all.push({ d, value: row.values[i], need: row.need, settleAt: spec.rollMs + r * (spec.staggerMs ?? 0) }));
    });
    const result = document.createElement('div');
    result.className = 'dice-result';
    el.append(result);

    const start = performance.now();
    const tumble = setInterval(() => {
      const t = performance.now() - start;
      for (const x of all) {
        if (x.done) continue;
        if (t >= x.settleAt) {
          x.done = true;
          face(x.d, x.value);
          x.d.style.transform = '';
          x.d.classList.add(x.value >= x.need ? 'hit' : 'miss');
          continue;
        }
        face(x.d, 1 + Math.floor(Math.random() * 6));
        x.d.style.transform = `rotate(${Math.round(Math.random() * 40 - 20)}deg) translateY(${Math.round(Math.random() * 6 - 3)}px)`;
      }
      if (all.every((x) => x.done)) {
        clearInterval(tumble);
        result.textContent = spec.result;
        el.classList.add('settled');
      }
    }, TUMBLE_EVERY_MS);
    timers.push(tumble);
  }

  function hide() {
    clear();
    el.hidden = true;
    el.replaceChildren();
  }

  return { show, hide };
}
