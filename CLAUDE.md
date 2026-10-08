# CLAUDE.md: Fix and Flank

A turn-based hex wargame of small unit infantry tactics for the browser. Modern setting, dismounted infantry, squad scale. The core loop is **fix and flank**: pin the enemy with a base of fire, maneuver a second element close, then finish them with an assault. A frontal assault on a dug-in enemy should usually fail.

The game is for a community of Arma Reforger players. It should feel familiar to them (terminology, tactics) and ideally double as a place to rehearse squad drills.

Reference for the feel: Brothers in Arms (fix, flank, finish). Reference for the format: Take That Hill (https://takethathill.com/play): traditional hexes, fireteam counters, dice, few orders.

The first version (2 m tiles, real-time WEGO with 10 second turns, percentage hit chances, directional cover, seven order types) was replaced on 2026-10-08 at the user's request. It is in git history up to commit `acfdbe8`.

---

## 1. Design pillars

1. **Fix and flank is the optimal strategy.** If a frontal assault is ever the best plan against an entrenched enemy, the balance is wrong.
2. **Dice, but never hidden dice.** Combat is resolved with d6 rolls. Before committing, the player sees the target number, the dice and the odds. After, the player sees the actual rolls and why.
3. **Turn-based, alternating activations.** Sides take turns activating one fireteam at a time until every fireteam has acted; then a new turn starts. Nothing moves while the player decides.
4. **Small and readable.** A BLUFOR squad of two fireteams against a few OPFOR fireteams. Each counter is a fireteam. Three orders: Move, Fast move, Fire.
5. **Real tactics, abstract presentation.** Correct doctrine and terminology, simple visuals (NATO-style counters, flat hexes). No made-up superweapons.

---

## 2. Tech stack and constraints

- **HTML5 canvas, plain JavaScript ES modules, no build step** (or TypeScript only if asked). Must run by opening a local server or hosting as static files.
- **Node for headless tests** (`node --test` or Vitest). Keep dependencies minimal and ask before adding any.
- Desktop browser first, mouse input. Keep layout responsive and do not block touch input later.
- No external network calls at runtime. All assets inline or in `/assets`.
- Free of real-world IP: generic factions (BLUFOR / OPFOR), generic weapon classes with realistic behavior.

---

## 3. Architecture

The simulation must be completely separate from rendering and UI.

```
/src
  /sim        pure logic, no DOM, no Math.random
    hex.js          hex coordinates, neighbors, distance, lines
    map.js          map loading, terrain lookups
    state.js        game state shape
    actions.js      action validation and resolution (the step function)
    los.js          line of sight and concealment on hexes
    spotting.js     fog of war and contact tracking
    combat.js       dice, target numbers, suppression, casualties, assault
    odds.js         exact odds for the preview
    rng.js          seeded RNG (mulberry32)
  /ai         enemy behavior, reads state and returns actions
  /render     canvas drawing only
  /ui         input, action planning, odds preview, AAR replay
/data
  balance.json      all tunable numbers (terrain table, dice modifiers)
  /maps             one JSON per mission
/tests
```

Rules for the simulation:

- **Deterministic.** Same state + same actions + same seed = same result, always. Tests depend on this.
- `applyAction(state, action, rng)` returns the new state and a list of **events** (activated, moved, fired, dice rolled, suppressed, casualty, spotted, assault, turn ended). The renderer, the log and the after-action replay all consume the events. Never let rendering logic decide outcomes.
- **No magic numbers in code.** Every tunable lives in `data/balance.json`.

---

## 4. Map model

- Pointy-top hex grid, offset rows ("odd-r": odd rows are shifted half a hex right). **1 hex = 50 m.** Maps are hand-built JSON, one character per hex.
- Each hex has one terrain type. The terrain table in `balance.json` gives each type: movement (normal, stops fast move, impassable), cover (a casualty roll number), concealment (hides units in it), and whether it blocks line of sight through it.
- Terrain types: open, road, scrub, woods, rubble, building, trench (dug-in fighting positions), water.
- **Cover and concealment are different.** Cover makes casualties less likely. Concealment hides a unit and, for woods and buildings, blocks sight through the hex.
- Stacking: one fireteam per hex.

---

## 5. Rules (first pass, all numbers tunable in `balance.json`)

### Units

A counter is one **fireteam**: side, team name (ALPHA, BRAVO...), soldiers (default 4: TL, AR, GRN, RFL), status (ok, shaken, pinned, eliminated), activated this turn, exposed (fast moved). Casualties remove soldiers; the AR is lost last. A team with no soldiers left is eliminated.

### Turn and activations

- Each turn, sides alternate activating one fireteam that has not yet acted, starting with BLUFOR. If one side has no fireteams left to activate, the other side activates its remaining ones in a row. When all have acted, the turn ends.
- At the start of each turn, suppressed teams roll to recover.
- An activation is one action: **Move**, **Fast move**, **Fire**, or pass.

### Actions

| Action | Effect |
|---|---|
| Move | 1 hex. The careful way: the team keeps its normal profile. |
| Fast move | Up to 2 hexes, but entering rough terrain ends it. The team is **exposed** until its next activation: easier to spot and to hit. |
| Fire | One d6 per soldier (AR rolls two) at a hex in range and line of sight. On a spotted enemy it is aimed fire; on a hex with no spotted enemy it is suppressive fire at worse odds. |
| Assault | Moving or firing into an **adjacent enemy hex** starts an assault (close combat). |

### Fire

- Target number (TN) on a d6, default 4+, modified by range, the target's cover, the target being exposed, the shooter being shaken or pinned, and firing at a hex with no spotted enemy. Clamped to 2+ .. 6+.
- Each die at or above the TN is a hit. 1 hit: the target is shaken (already shaken: pinned). 2 or more hits: pinned.
- Each hit gets a casualty roll against the target's cover (for example 4+ in the open, 6 in a trench). Each success removes a soldier.
- Pinned teams cannot move and fire at worse odds. Shaken teams fire at slightly worse odds.

### Assault

Close combat when a team moves or fires into an adjacent enemy hex. Both sides roll a die per soldier at the same time; each success removes an enemy soldier. The attacker's TN depends on the defender's state (pinned easiest) and the defender's TN on the defender being dug in. If the defender is wiped out or ends with fewer soldiers than the attacker, it is eliminated and the attacker takes the hex; otherwise the attacker falls back pinned. Against an unsuppressed team in cover, an assault should be costly.

### Vision and fog of war

- Line of sight runs from hex center to hex center; woods and buildings in between block it. The target's own hex never blocks.
- Enemy contacts have three levels: **unseen**, **suspected** (last known position, or a hex that fired), **spotted** (confirmed, shown on the map).
- A unit in line of sight is spotted if it is in the open, adjacent, exposed, or has fired this turn. Firing reveals the shooter, which is how a dug-in enemy gets found.

### Odds preview (important)

Before committing, the UI tells the player what will happen, for example:

- "ALPHA fires on the trench at 6,3: 5 dice, hit on 6. 60% chance of at least one hit, 18% to pin. Expected casualties 0.2."
- "No spotted enemy at 6,3: suppressive fire, hit on 6+ (+2 for firing blind)."
- "BRAVO fast moves 2 hexes in view of a known enemy: exposed until its next activation."

### After-action replay

Every action can be replayed with its dice and an explanation (target number and modifiers, which dice hit, casualty rolls). This is what makes the game useful for drill practice.

---

## 6. Enemy AI

Scripted behavior per enemy fireteam, using the **same visibility and rules as the player**, no cheating.

States: `HOLD` (dug in, fire on spotted targets), `ENGAGED` (taking fire, return fire on known contacts), `SUPPRESSED` (pinned: wait to recover), `REPOSITION` (move to better cover), `COUNTER_FLANK` (move against the player's maneuver element if it has enough unsuppressed soldiers), `RETREAT`.

Design goal: the AI reacts sensibly to suppression and sometimes counterattacks, so the same plan does not win every time. Difficulty levels change aggression and dice modifiers, not information.

---

## 7. Milestones

Work one milestone at a time. Do not start the next until the current one passes its acceptance check. Milestone 1 (scaffold) carries over from the first version.

1. **Scaffold.** Done.
2. **Hex map, counters, activations, movement.** Hex map from JSON, fireteam counters, alternating activations, Move and Fast move, pass. *Accept:* activation order rules tested; deterministic replay of an action list.
3. **Line of sight and fog on hexes.** *Accept:* unit tests for LOS through woods and buildings, and the spotting rules.
4. **Fire with dice, suppression, casualties, recovery.** *Accept:* tests for target numbers and modifiers; outcome frequencies over many seeded rolls match the exact odds; a team in a trench is much harder to kill than one in the open.
5. **Assault and the odds preview.** *Accept:* preview odds equal the exact odds the sim rolls against.
6. **Enemy AI.** *Accept:* AI fires from its positions, waits when pinned, and sometimes counterattacks.
7. **First mission and balance test.** BLUFOR squad vs. dug-in OPFOR. *Accept (automated):* over 200 seeded runs, a scripted frontal assault wins under 25 percent and a scripted fix-and-flank plan wins over 70 percent. Adjust `balance.json` until this holds.
8. **After-action replay** with dice and explanations.
9. **Content.** More missions, terrain, difficulty levels. Only after the core loop is proven fun.

Later, out of scope for now: vehicles, drones, indirect fire, multiple squads, campaign, multiplayer.

---

## 8. How to work in this repo

- Keep the simulation headless and covered by tests. Run the tests after every change to `/src/sim` or `/src/ai`.
- Prefer small commits, one concern each, with a clear message.
- When a rule is ambiguous, pick the simplest option, write it down in `docs/decisions.md`, and continue. Do not silently invent complex systems.
- Do not add dependencies, frameworks, or a build step without asking.
- When balance feels off, change `balance.json`, not code, and re-run the milestone 7 balance test.
- Keep UI text plain and in the vocabulary of infantry tactics (fireteam, base of fire, contact, bounding, suppress, flank, assault). No filler, no flowery language.
- After each milestone, summarize what works, what is stubbed, and what you would test next.

---

## 9. Open questions

**Resolved 2026-09-30, see `docs/decisions.md`:** both game and drill tool; desktop first; anonymous soldiers by role; hand-built maps only; distribution decided later.

**Resolved 2026-10-08 (hex redesign):** 50 m hexes; alternating activations; fireteam counters of 4; d6 per shooter with odds shown; keep fog of war, suppression states and the odds preview; drop directional cover.
