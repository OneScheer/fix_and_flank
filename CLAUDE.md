# CLAUDE.md: Fix and Flank

A turn-based hex wargame of small unit infantry tactics for the browser. Modern setting, dismounted infantry, squad scale. The core loop is **fix and flank**: pin the enemy with a base of fire, maneuver a second element close, then finish them with an assault. A frontal assault on a dug-in enemy should usually fail.

The game is for a community of Arma Reforger players. It should feel familiar to them (terminology, tactics) and ideally double as a place to rehearse squad drills.

Reference for the feel: Brothers in Arms (fix, flank, finish). Reference for the format: Take That Hill (https://takethathill.com/play): traditional hexes, fireteam counters, dice, few orders.

The first version (2 m tiles, real-time WEGO with 10 second turns, percentage hit chances, directional cover, seven order types) was replaced on 2026-10-08 at the user's request. It is in git history up to commit `acfdbe8`.

---

## 1. Design pillars

1. **Fix and flank is the optimal strategy.** If a frontal assault is ever the best plan against an entrenched enemy, the balance is wrong.
2. **Dice, but never hidden dice.** Combat is resolved with d6 rolls. Before committing, the player sees the target number, the dice and the odds. After, the player sees the actual rolls and why.
3. **Turn-based, in phases (after Take That Hill).** Each turn runs Movement, Firefight, Rally, Enemy action. In each of its phases the player gives every unit an order and commits them all; they are carried out in the order given. Nothing moves while the player decides.
4. **Small and readable.** A BLUFOR squad of two fireteams and a squad leader against a few OPFOR fireteams. Each counter is a fireteam (or the SL). Three orders: Move, Fast move, Fire. The SL rallies by being close (the rally phase).
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
    orders.js       a side's orders: commit, and planning projections
    phases.js       the turn sequence: movement, firefight, rally, enemy action
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
- `applyAction(state, action, rng)` resolves one unit's order and `commitOrders(state, actions, rng)` a whole side's; both return the new state and a list of **events** (activated, moved, fired, dice rolled, suppressed, casualty, spotted, assault, turn ended). The renderer, the log and the after-action replay all consume the events. Never let rendering logic decide outcomes.
- **No magic numbers in code.** Every tunable lives in `data/balance.json`.

---

## 4. Map model

- Pointy-top hex grid, offset rows ("odd-r": odd rows are shifted half a hex right). **1 hex = 50 m.** Maps are hand-built JSON, one character per hex.
- Each hex has one terrain type. The terrain table in `balance.json` gives each type: movement (normal, stops fast move, impassable), cover (a casualty roll number), concealment (hides units in it), and whether it blocks line of sight through it.
- Terrain types: open, road, scrub, woods, rubble, building, trench (dug-in fighting positions), water.
- **Hexside features** sit on one of a hex's six sides (E, SE, SW, W, NW, NE): **wall** and **hedge** are on the edge between two hexes and count for both; a **parapet** belongs to its trench hex only.
- **Cover and concealment are different.** Cover makes casualties less likely. Concealment hides a unit and, for woods and buildings, blocks sight through the hex.
- Stacking: one fireteam per hex, plus the squad leader.

### Directional cover (the core mechanic)

- A unit's cover against fire from a hex is the better of its hex's terrain (protects all round) and the feature on the side of its hex facing the shooter. If the line of fire runs exactly through a hex corner, the better of the two sides counts.
- So a trench with parapets facing south is hard to hurt from the south and only trench-covered from the east or west. Flanking means firing through a side without a feature.

---

## 5. Rules (first pass, all numbers tunable in `balance.json`)

### Units

A counter is one **fireteam**: side, team name (ALPHA, BRAVO...), soldiers (default 4: TL, AR, GRN, RFL), status, activated in this phase, moved, exposed (fast moved), fired. Casualties remove soldiers; the AR is lost last. A team with no soldiers left is eliminated.

The **squad leader (SL)** is a counter of one man. He moves and fires like a team and may share a hex with one fireteam. He has no rally order: his position drives the **rally phase** (below).

Status: **ok**, **suppressed** (cannot move, can still fire), **pinned** (cannot move and cannot shoot back), eliminated.

### Turn and phases

Each turn runs four phases, in the order set in `balance.json` (`turn.phases`), after the Take That Hill turn sequence:

1. **Movement** (BLUFOR): Move or Fast move, or hold. A unit that moves is spent: it cannot fire this turn.
2. **Firefight** (BLUFOR): units that did not move and are not pinned may Fire, or hold.
3. **Rally** (BLUFOR, automatic): every suppressed or pinned unit tries to improve one step. With the SL in its hex it succeeds without a roll. Otherwise it rolls a d6 and must beat its distance in hexes to the SL (needs distance + 1, never worse than 6+; 6+ with no SL). A unit next to an enemy cannot rally unless the SL is with it.
4. **Enemy action** (OPFOR): each suppressed or pinned enemy unit recovers one step and does nothing else; the others Move, Fast move or Fire.

- In a phase that needs orders, the side gives an order to every unit that can act and commits them; the orders are carried out one after another in the order they were given, each rolling its own dice. A unit without an order holds. An order that has become impossible by the time it runs is skipped with the reason, and that unit holds.
- While planning, each order is checked against where the earlier orders will have put things, so a team can move into a hex another team leaves earlier in the plan. Dice results are not known while planning.
- A phase in which nobody can act is skipped. A side's first phase in a turn starts its turn: its units' moved, exposed and fired flags are cleared.

### Actions

| Action | Effect |
|---|---|
| Move | 1 hex. The careful way: the team keeps its normal profile. A unit that moved cannot fire this turn. |
| Fast move | Up to 2 hexes, but entering rough terrain ends it. The team is **exposed** until its side's next turn: easier to spot and to hit. It cannot fire this turn. |
| Fire | One d6 per soldier (AR rolls two) at a hex in range and line of sight. On a spotted enemy it is aimed fire; on a hex with no spotted enemy it is suppressive fire at worse odds. |
| Assault | Moving or firing into an **adjacent enemy hex** starts an assault (close combat). |

### Fire

- Target number (TN) on a d6, default 4+, modified by range, the target's cover, the target being exposed, the shooter being suppressed, and firing at a hex with no spotted enemy. Clamped to 2+ .. 6+.
- Each die at or above the TN is a hit. 1 hit: the target is suppressed (already suppressed: pinned). 2 or more hits: pinned.
- Each hit gets a casualty roll against the target's directional cover (for example 4+ in the open, 5+ in a trench seen from the flank, 6 behind its parapet). Each success removes a soldier.
- **Units that moved this turn cannot fire** until the next turn.
- Suppressed teams cannot move and fire at worse odds. Pinned teams cannot move or fire.

### Assault

Close combat when a team moves or fires into an adjacent enemy hex. Both sides roll a die per soldier at the same time (a pinned defender cannot shoot back); each success removes an enemy soldier. The attacker's TN depends on the defender's state (pinned easiest) and the defender's TN on the defender being dug in. If the defender is wiped out or ends with fewer soldiers than the attacker, it is eliminated and the attacker takes the hex; otherwise the attacker falls back pinned. Against an unsuppressed team in cover, an assault should be costly.

### Vision and fog of war

- Line of sight runs from hex center to hex center; woods and buildings in between block it. The target's own hex never blocks.
- Enemy contacts have three levels: **unseen**, **suspected** (last known position, or a hex that fired), **spotted** (confirmed, shown on the map).
- A unit in line of sight is spotted if it is in the open, adjacent, exposed, or has fired this turn. Firing reveals the shooter, which is how a dug-in enemy gets found.

### Odds preview (important)

Before committing, the UI tells the player what will happen, for example:

- "ALPHA fires on the trench at 6,3: 5 dice, hit on 6. 60% chance of at least one hit, 18% to pin. Expected casualties 0.2."
- "No spotted enemy at 6,3: suppressive fire, hit on 6+ (+2 for firing blind)."
- "Rally phase: ALPHA needs 3+ on a d6 to become suppressed, 4 in 6 (67%; SL 2 hexes away)."
- "BRAVO fast moves 2 hexes in view of a known enemy: exposed until its next turn."

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
2. **Hex map, counters, orders, movement.** Hex map from JSON, fireteam and SL counters, orders for the whole side committed per phase, Move and Fast move, hold, the phase sequence with the rally phase. *Accept:* turn order rules tested; deterministic replay of an action list.
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

**Resolved 2026-10-08 (hex redesign):** 50 m hexes; alternating activations at first, then (same day) orders for the whole side committed together; fireteam counters of 4; d6 per shooter with odds shown; keep fog of war, suppression states and the odds preview; directional cover dropped at first, then restored the same day as hexside cover (walls, hedges, parapets). Also added the same day: moved units cannot fire that turn; squad leader counter with Rally; suppressed (no move) and pinned (no move, no fire). Later the same day: the Take That Hill phase sequence (movement, firefight, rally, enemy action) replaced the SL's Rally order and the turn-start recovery roll.
