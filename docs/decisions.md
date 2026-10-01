# Decisions

Answers to open questions and rulings on ambiguous rules. Newest at the bottom.

## Open questions from CLAUDE.md section 9 (resolved 2026-09-30)

1. **Purpose:** both a standalone game and a drill-rehearsal tool. The order preview and AAR explanations are always on and are a core feature.
2. **Platform:** desktop first, mouse input. Layout stays responsive and must not block touch later (canvas uses `touch-action: none`).
3. **Scale:** 2 m tiles, 80 x 80 default map. Both in `data/balance.json` (`map.*`).
4. **Soldiers:** anonymous, labeled by role (TL, AR, GRN, RFL). Names can be added later without sim changes.
5. **Maps:** hand-built JSON only. No real-terrain import planned.
6. **License and distribution:** decided later. The game stays plain static files so either itch.io or a community site works.

## Milestone 1

- **RNG:** mulberry32. The whole generator state is one uint32 (`getState` / `setState`), so it can be stored in game state and restored exactly for replay.
- **Tests:** built-in `node --test`, no dependencies. Run with `npm test`.
- **Local server:** `scripts/serve.js`, a zero-dependency Node static server (`npm start`, port 8080). Any static server works too, because the browser loads plain ES modules.
- **Turn timing:** `ticksPerTurn = turn.durationSec / turn.tickSec`. A value that does not divide evenly is a config error, not rounded.

## Milestone 2: map and movement

- **Map files** (`data/maps/*.json`): `width`, `height`, a `legend` mapping one character to a tile (`terrain`, `height`, `cover`, `concealment`, `feature`), `rows` of characters, and `units` (`side`, `team`, `role`, `pos`). Missing tile fields default to height 0 / none. Maps are frozen after parsing and shared between states.
- **Tile features:** `door` (passable gap in a wall) and `window` (height 1, impassable, lets sight and fire through later). Added to the section 4 tile fields because walls need them.
- **Passability:** water, height 2 and windows block movement. Height 1 (low walls) is passable at `movement.lowObstacleCost` times the terrain cost. Diagonal steps may not cut the corner of an impassable tile.
- **New sim modules:** `map.js` (parsing, passability, step cost) and `path.js` (A*), alongside the files listed in CLAUDE.md.
- **Pathfinding:** A*, 8 directions, fixed neighbor order and insertion-order tie-break so paths are identical every run. Paths ignore soldiers; soldiers are handled tick by tick.
- **Formation (superseded, see below):** a team move order sends the team leader (TL, else lowest id) to the clicked tile; every other soldier keeps its offset from the leader. A slot that is off the map, impassable or already taken moves to the nearest free tile within `movement.formationSearchRadius`. Followers take the leader's route shifted by their offset so the team keeps its shape; if that route is blocked they path on their own. Only own-side soldiers are considered when planning, so planning never uses hidden enemy positions.
- **Speeds and stance:** walk 1.5 m/s (crouched), run 4 m/s (standing), crawl 0.4 m/s (prone). Giving a move order sets the stance. All in `balance.json`.
- **Order lifetime:** a move order persists across turns until the team arrives, gets a new order, or is told to hold. One order per team per turn; a later one replaces an earlier one.
- **Simultaneous movement:** each tick every mover gains progress, then soldiers step in id order against live occupancy, in repeated passes until nobody can move. Nobody steps into an occupied tile. A soldier that is still blocked keeps one step of progress, waits, and emits one `blocked` event (not one per tick). Two soldiers meeting head on in a one-tile corridor will wait forever; the player has to re-route them (acceptable for now).
- **step / resolveTurn:** `step(state, orders, rng)` advances one tick and applies `orders` at the start of that tick. `resolveTurn(state, orders)` runs a full turn, passing the orders on tick 0 only, and seeds the RNG from and saves it back to `state.rngState`, so a saved state resumes exactly.
- **Squad:** two fireteams of four (TL, AR, GRN, RFL). No squad leader counter yet; commands go to teams.
- **Fog:** not yet. OPFOR is visible to the player until Milestone 3. `blocked` events name the blocking soldier, which will need filtering once fog exists.
- **Enemy:** OPFOR gets no orders until the AI in Milestone 6.
- **Waypoints:** a move order may carry `via`, a list of up to `movement.maxWaypoints` tiles the team leader passes through in order. Followers still take the leader's route shifted by their offset; if that is blocked they route through their own offset of each waypoint (or the waypoint itself if the offset tile is impassable). UI: click sets a new move, Shift+click adds a point (the previous destination becomes a waypoint), Backspace removes the last point, Delete clears the order.

## Milestone 3: line of sight and fog

- **Ray:** supercover line between tile centers (every tile it touches). The observer's and target's own tiles never block, so a soldier at a treeline or on a low wall tile can see out. Where the ray passes exactly through a tile corner, the more open of the two side tiles counts: symmetric, and no seeing through solid diagonal walls.
- **Height:** sight runs from the observer's eye height to the target's height (both by stance: stand 1.6 m, crouch 1.1 m, prone 0.3 m) and is blocked where a tile's obstacle height reaches the line (low wall or window 1.0 m, wall 3 m). A low wall hides prone soldiers, not crouched or standing ones. If the line clears a low obstacle by less than 0.3 m the target is **partly hidden** (harder to spot; cover itself comes in Milestone 4). No terrain elevation yet.
- **Concealment:** each tile on the ray adds its density (partial 0.15, full 0.35); sight is blocked at 1.0, so about two tiles of forest can be seen through and three cannot. Concealment ignores height. It never affects bullets.
- **Range:** max 300 m.
- **Every blocked line has a reason** (`wall at 40,16`, `too much concealment (forest) at 58,46`, `out of range`) for the preview and the AAR.
- **Contacts** are per side and shared by the whole side: `state.contacts[side][enemyId] = { level, pos, lastSeenSec }`. Absent means unseen.
- **Spotting:** each tick, for each enemy not yet spotted, the side gets **one** roll using the best chance among its soldiers with LOS (more eyes do not stack), or spots it outright within 6 m. Chance per second = base 0.5 x range falloff 1/(1+(r/40 m)^2) x target stance (1 / 0.4 / 0.2) x target tile concealment (1 / 0.5 / 0.25) x (1 - concealment along the ray) x partly hidden 0.15 x moving 2. Converted to a per-tick chance. All numbers in `balance.json` (`vision`, `spotting`).
- **Spotted** contacts track the enemy while anyone on the side keeps LOS. On losing sight they become **suspected** at the last known position, and are dropped after 60 s. Suspected contacts will also come from muzzle flashes in Milestone 4.
- **Tuning target used:** four crouched OPFOR behind the training map's low wall, not firing, about 100 m away, are spotted in the first turn in under 25% of runs (about 15-20% now). A dug-in enemy is meant to be found mainly by its fire (Milestone 4).
- **UI:** only spotted enemies are drawn; suspected ones are a dashed `?` marker at the last known position; the event log only shows what BLUFOR knows. **LOS check** (L) draws lines from the selected team to the hovered tile, with reasons, against a crouched target (or the stance of a soldier the player can see there). **V** is a debug toggle that shows all OPFOR faintly; it is labelled DEBUG in the header.
- **Known gap:** a `blocked` event can occur when bumping into an unseen enemy; the log says "blocked" without naming who. Spotting at 6 m will usually have revealed them first.

## Fixes after Milestone 3 playtest

- **Wedge formation replaces "keep current offsets".** Keeping each soldier's current offset from the TL made a soldier who fell behind stay behind for the rest of the game. Now a move order puts the team in a fixed fireteam wedge on the destination: TL at the point, then the others in id order (on the training map AR back-left, GRN back-right, RFL trailing right), `movement.formation.spacingTiles` (2 tiles, 4 m) apart. The wedge faces the last leg of the route (from the last waypoint, or the TL, to the destination), snapped to 8 directions. Slots that are blocked still move to the nearest free tile. A follower already in its slot takes the TL's route shifted over; anyone out of place (a straggler, or because the wedge turned) routes on its own and closes up. Training map start positions are now in wedge.
- **Grid lines are off by default.** G toggles them (debug).

## Milestone 4: combat, suppression, directional cover

- **Weapons** live in `data/weapons.json`: `rifle` (2-round bursts every 2 s, 210 rounds, optic) and `lmg` (5-round bursts every 2 s, 400 rounds). The AR carries the LMG; everyone else a rifle. A map unit can name its own `weapon`. Hit chance by range is a table per weapon, interpolated linearly, 0 beyond `maxRangeM`.
- **Hit chance** = base(weapon, range) x shooter stance (stand 0.85 / crouch 1 / prone 1.1) x target stance (1 / 0.75 / 0.5) x movement this tick (still 1 / walk 0.5 / run 0.15 / crawl 0 = cannot fire) x cover (1 - protection) x shooter suppression (active 1 / shaken 0.6 / pinned 0.25) x wounded 0.7 x optic. Clamped to [0.01, 0.95]. "Stance modifier" in CLAUDE.md is split into shooter and target stance. Every factor is returned and written into the `fire` event.
- **Directional cover** (`cover.js`): the shot's direction from target to shooter is snapped to 8 directions; protection is the best of the adjacent tile in that direction and the target's own tile (none 0, light 0.25, heavy 0.5, hard 0.8). Full-height walls protect at any stance; all other cover is scaled by stance (prone 1, crouch 0.8, stand 0.3). A shooter standing on that neighbor tile is past the cover. Concealment does not reduce hit chance.
- **Fire at will (until Milestone 5 orders):** every soldier able to fire shoots at the spotted enemy it has the best hit chance on (ties: nearest). Down and dead enemies are not targeted. Fire is simultaneous within a tick: everyone picks targets from the same state, then shots resolve in id order (a soldier killed this tick still gets his shot off).
- **Damage:** fixed 45 per hit, hp 100. hp under 100 = wounded (accuracy 0.7), 25 or less = down (out of the fight), 0 = dead. Fixed damage keeps outcomes readable; the dice are only hit or miss.
- **Suppression:** each burst adds rounds x suppressionPerRound to the target, and a share (1 - d/3) to its side within 2 tiles, hit or miss. No friendly fire. Decay 4/s, x1.5 prone, x1.5 in cover (own tile has cover, or a covering obstacle next to the soldier), x0.25 while under fire (2 s after the last burst). Shaken at 40, pinned at 70, capped at 100. Pinned soldiers go prone, stop moving (their move resumes when they recover, in the move's stance), cannot be given new move orders, and fire at half rate and a quarter accuracy. **Broken at 100 (retreat / surrender) is not implemented yet**; it belongs with the AI (Milestone 6).
- **Status** is derived each tick: dead > down > pinned > shaken > wounded > active.
- **Muzzle flash:** a burst makes the shooter a suspected contact for the other side if any of its soldiers is within 250 m, and a soldier who fired in the last 10 s is 4x easier to spot. This is how the dug-in team gets found.
- **Tick order:** orders, movement, fire, suppression decay and status, spotting.
- **Known consequence:** a pinned enemy behind a low wall goes prone and drops out of sight, so fire at will stops. Keeping fire on a suspected position is the Suppress order (Milestone 5).
- **UI:** tracers (BLUFOR yellow, OPFOR red) and hit flashes during playback; shaken (yellow) and pinned (red) rings; suppression bar under own counters; X for down/dead (enemy casualties shown when BLUFOR hit them); hover shows hp, suppression and ammo; the log explains each burst (`7% per round: range 55 m, target behind low wall from the south, target crouched`).
