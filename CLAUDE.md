# CLAUDE.md: Fix and Flank

A turn-based, plan-then-watch small unit infantry tactics game for the browser. Modern setting, dismounted infantry, squad scale. The core loop is **fix and flank**: pin the enemy with a base of fire, maneuver a second element onto their exposed side, then finish them. A frontal assault on a dug-in enemy should usually fail.

The game is for a community of Arma Reforger players. It should feel familiar to them (terminology, tactics) and ideally double as a place to rehearse squad drills.

Reference for the feel: Brothers in Arms (fix, flank, finish). Reference for the format: Contrail Tactics (plan every turn, press ENGAGE, watch ten seconds play out, the UI tells you whether a shot will happen before you commit).

---

## 1. Design pillars

1. **Fix and flank is the optimal strategy.** If a frontal assault is ever the best plan against an entrenched enemy, the balance is wrong.
2. **Nothing is hidden dice.** The player can always see why something happened (in the order preview before committing, and in the after-action replay afterward).
3. **Turn-based, simultaneous resolution (WEGO).** Nothing moves while the player plans. Both sides' orders resolve together over one 10 second turn.
4. **Small and readable.** Squad level: 8 to 12 friendly soldiers in two fireteams. Commands are given to teams, not individuals.
5. **Real tactics, abstract presentation.** Correct doctrine and terminology, simple visuals (NATO-style counters, flat tiles). No made-up superweapons.

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
    state.js        game state shape
    step.js         advance the state by one tick
    los.js          line of sight and concealment
    cover.js        directional cover from neighbor tiles
    combat.js       hit chance, suppression, damage
    spotting.js     fog of war and contact tracking
    orders.js       order types and validation
    rng.js          seeded RNG (mulberry32 or similar)
  /ai         enemy behavior, reads state and returns orders
  /render     canvas drawing only
  /ui         input, order planning, preview line, AAR replay
/data
  balance.json      all tunable numbers (see section 5)
  weapons.json
  /maps             one JSON per mission
/tests
```

Rules for the simulation:

- **Deterministic.** Same state + same orders + same seed = same result, always. Tests depend on this.
- `step(state, orders, rng)` returns the new state and a list of **events** (shot fired, suppressed, hit, spotted, killed, moved). The renderer and the after-action replay both consume the events. Never let rendering logic decide outcomes.
- **No magic numbers in code.** Every tunable lives in `data/balance.json`.
- A turn is 10 seconds, simulated in fixed ticks of 0.5 seconds (20 ticks). Tick length is configurable.

---

## 4. Map model

- Square tile grid. Default 1 tile = 2 m. Default map 80 x 80 tiles. Both configurable.
- Each tile has: `terrain` (open, road, grass, scrub, forest, rubble, water), `height` (0 none, 1 low, 2 high), `cover` (none, light, heavy, hard), and `concealment` (none, partial, full).
- **Cover and concealment are different.** Cover stops bullets. Concealment only blocks sight. A bush hides you but does not protect you. A wall protects you and may or may not hide you.
- Buildings: walls are high, hard cover with door and window tiles that allow passage or fire.

### Directional cover (the core mechanic)

Do not store a facing on cover objects. Derive protection from neighbors:

- A soldier's protection against fire arriving from direction `d` (8 directions) is the best cover value among the tile adjacent in direction `d`, and the soldier's own tile if it carries cover.
- So a soldier behind a wall is protected from the wall side and **fully exposed from the other sides**. Flanking means firing from outside the protected arc.
- Stance scales cover: prone gets the most benefit from low cover, standing gets almost none.

---

## 5. Rules (first pass, all numbers tunable in `balance.json`)

### Soldier state

`pos`, `stance` (stand, crouch, prone), `suppression` (0 to 100), `ammo`, `weapon`, `status` (active, shaken, pinned, wounded, down, dead), `team` (ALPHA, BRAVO, etc.), `hp`.

### Suppression

- Every shot that passes near a soldier adds suppression, whether or not it hits. Automatic fire adds more than single shots. Near misses scale with proximity and weapon class.
- Suppression decays slowly each second, faster when prone and in cover, slower when the soldier is being fired at.
- Thresholds (defaults): **shaken** at 40 (accuracy penalty), **pinned** at 70 (cannot move, only poor return fire, will not expose themselves), at 100 the soldier is broken and may retreat or surrender.
- Ammo is limited. Suppression is a resource the player spends, so a base of fire must be planned, not spammed.

### Hit chance

```
hit = base(weapon, range)
    x stance_modifier
    x movement_modifier        (moving and running hurts accuracy)
    x cover_modifier           (directional, see section 4)
    x suppression_modifier     (shaken and pinned shooters miss more)
    x optic_modifier
```

Clamp to a sensible range. Every factor is exposed in the preview and the replay.

### Vision and fog of war

- Line of sight uses a tile raycast (Bresenham or supercover) against `height` and `concealment`.
- Enemy contacts have three levels: **unseen**, **suspected** (muzzle flash or last known position, shown as an uncertain marker), **spotted** (confirmed, can be targeted precisely).
- Firing reveals the shooter (muzzle flash), which is how a dug-in enemy gets found. Suppressive fire can target a suspected position, at lower accuracy.
- Spotting chance depends on range, stance, concealment, and whether the target fired this turn.

### Orders (given per team, executed per soldier)

| Order | Effect |
|---|---|
| Move | Path to a tile. Speeds: walk, run, crawl (affects noise, accuracy, exposure) |
| Suppress | Sustained fire on a target tile or contact. Spends ammo, raises target suppression |
| Fire | Aimed fire on a spotted contact |
| Overwatch | Hold position, engage anything that appears in an arc |
| Assault | Move and close with a target. Only effective against suppressed targets |
| Grenade | Throw to a tile within range (40mm or hand), area suppression and damage |
| Stance | Change stance |

The player can set a separate order for each team (for example ALPHA suppresses, BRAVO moves to a flanking tile).

### Finish

A close assault or grenade has a high kill chance only if the target is pinned or exposed from the attacker's direction. Against an unsuppressed soldier in cover, an assault should be costly.

### Order preview (important)

Before pressing GO, a status line for each order tells the player what will actually happen, for example:

- "ALPHA has no line of sight to target. Suppression will hit a suspected position at reduced accuracy."
- "BRAVO route crosses open ground in view of the enemy for about 6 tiles."
- "ALPHA will run out of ammo after about 7 seconds of fire."

### After-action replay

Every turn can be replayed with an explanation layer. When a shot misses or an order fails, the replay shows the reason in plain words (suppressed, out of ammo, target in heavy cover from that direction, no LOS). This is what makes the game useful for drill practice.

---

## 6. Enemy AI

Scripted state machine per enemy team. The AI uses the **same visibility and rules as the player**, no cheating.

States: `HOLD` (dug in, return fire), `ENGAGED` (taking fire, return fire on known contacts), `SUPPRESSED` (go to ground, minimal fire), `REPOSITION` (move to better cover), `COUNTER_FLANK` (try to reach the player's exposed side if enough unsuppressed soldiers), `RETREAT`.

Design goal: the AI reacts sensibly to suppression and sometimes tries to flank, so the same plan does not win every time. Difficulty levels change reaction speed, accuracy, and aggression, not information.

---

## 7. Milestones

Work one milestone at a time. Do not start the next until the current one passes its acceptance check.

1. **Scaffold.** Project layout, static server script, empty canvas, seeded RNG, test runner working.
2. **Map and movement.** Load a map from JSON, render tiles, select a team, plan a move path, execute a turn with simultaneous movement. *Accept:* deterministic replay of the same orders.
3. **Line of sight and fog.** Raycast LOS, concealment, contact levels (unseen, suspected, spotted). *Accept:* unit tests for LOS across walls, bushes, and height.
4. **Combat, suppression, directional cover.** Hit chance, suppression thresholds, cover derived from neighbors. *Accept:* unit tests showing a soldier behind a wall is hard to hit from the front and easy to hit from the flank.
5. **Orders and UI.** All order types, two-team planning, preview line. *Accept:* the preview matches what actually happens in the sim.
6. **Enemy AI.** State machine from section 6. *Accept:* AI goes to ground when suppressed and sometimes counter-flanks.
7. **First mission and balance test.** One map: a BLUFOR squad vs. a dug-in OPFOR fireteam. *Accept (automated):* over 200 seeded runs, a scripted frontal assault wins under 25 percent and a scripted fix-and-flank plan wins over 70 percent. Adjust `balance.json` until this holds.
8. **After-action replay** with explanations.
9. **Content.** More missions, terrain types, difficulty levels, weapons. Only after the core loop is proven fun.

Later, out of scope for now: vehicles, drones, indirect fire, multiple squads, campaign, multiplayer.

---

## 8. How to work in this repo

- Keep the simulation headless and covered by tests. Run the tests after every change to `/src/sim` or `/src/ai`.
- Prefer small commits, one concern each, with a clear message.
- When a rule is ambiguous, pick the simplest option, write it down in `docs/decisions.md`, and continue. Do not silently invent complex systems.
- Do not add dependencies, frameworks, or a build step without asking.
- When balance feels off, change `balance.json`, not code, and re-run the milestone 7 balance test.
- Keep UI text plain and in the vocabulary of infantry tactics (fireteam, base of fire, contact, overwatch, bounding, suppress, flank). No filler, no flowery language.
- After each milestone, summarize what works, what is stubbed, and what you would test next.

---

## 9. Open questions (ask the user before assuming)

1. Primary purpose: standalone game, or drill-rehearsal tool for the Reforger community, or both? (Affects how much the game explains itself.)
2. Desktop only, or phone-first like Contrail Tactics?
3. Tile scale and map size: is 2 m tiles and 80 x 80 right, or should maps be bigger?
4. Should the player command named soldiers with persistent stats, or anonymous riflemen?
5. Real terrain from open map data later (as Contrail Tactics does for Iceland), or hand-built maps only?
6. License and distribution: itch.io HTML5 build, or hosted on the community site?
