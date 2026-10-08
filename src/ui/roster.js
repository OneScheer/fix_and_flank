// Team roster panel: one card per team with hitpoint pips per soldier.
// Reads team summaries from the sim, writes DOM only.
import { ROLES } from '../sim/state.js';

const HEALTH_LABEL = { active: 'ACTIVE', wounded: 'WOUNDED', down: 'DOWN' };
const SUPPRESSION_LABEL = { none: 'Effective', suppressed: 'Suppressed', pinned: 'Pinned' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function casualtyLine(summary) {
  const parts = [];
  if (summary.wounded) parts.push(`${summary.wounded} wounded`);
  if (summary.down) parts.push(`${summary.down} down`);
  return parts.length ? `Casualties: ${parts.join(', ')}` : 'No casualties';
}

function soldierRow(s) {
  const row = el('div', `roster-row is-${s.health}`);
  row.append(el('span', 'roster-code', s.role));

  const who = el('div', 'roster-who');
  who.append(el('span', 'roster-role', ROLES[s.role].name));
  who.append(el('span', 'roster-weapon', ROLES[s.role].weapon));
  row.append(who);

  const pips = el('div', 'roster-pips');
  pips.setAttribute('aria-label', `${s.hp} of ${s.hpMax} hitpoints`);
  for (let i = 0; i < s.hpMax; i++) pips.append(el('span', i < s.hp ? 'pip is-on' : 'pip'));
  row.append(pips);

  row.append(el('span', 'roster-hp', `${s.hp}/${s.hpMax}`));
  row.append(el('span', `roster-tag is-${s.health}`, HEALTH_LABEL[s.health]));
  return row;
}

export function renderRoster(container, summaries) {
  container.replaceChildren();
  for (const t of summaries) {
    const card = el('section', 'roster-card');
    const head = el('div', 'roster-head');
    const title = el('div', 'roster-title');
    title.append(el('h2', null, t.name));
    title.append(el('span', 'roster-total', `HP ${t.hp}/${t.hpMax}`));
    head.append(title);
    head.append(el('span', `roster-state is-${t.suppressionLevel}`, SUPPRESSION_LABEL[t.suppressionLevel]));
    card.append(head);
    card.append(el('p', 'roster-casualties', casualtyLine(t)));
    const list = el('div', 'roster-list');
    for (const s of t.roster) list.append(soldierRow(s));
    card.append(list);
    container.append(card);
  }
}
