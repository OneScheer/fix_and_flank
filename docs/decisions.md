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

## Milestone 5: orders and preview

- **Orders persist as soldier tasks** until the team gets a new order: `fire` (one spotted contact), `suppress` (a tile or a known contact; the aim follows the contact's last known position), `overwatch` (toward a point), `assault`, `grenade` (one throw, then the team fires at will), `stance`, `hold`, `move`. A team with no fire task fires at will. Move and assault need soldiers able to move; the other orders also go to pinned soldiers (they fire at half rate and a quarter accuracy).
- **Hold fire (added):** a move order can carry `holdFire`; the team does not shoot at all, on the way or after arriving, until its next order. CLAUDE.md's order table has no hold-fire, but without it the flanking element gives itself away by firing on the move. UI: X / "Hold fire" next to the move speeds.
- **Fire mode factor** joins the hit chance: aimed 1, overwatch 1.2, suppress 0.5, suppress on a soldier the side has not spotted 0.25.
- **Suppress** needs only a line of fire to the aim point (height blocks, concealment does not; checked at crouch height). It fires at twice the aimed rate, so ammo goes twice as fast. Each burst suppresses the enemy side around the aim point (full at the point, less out to 2 tiles) and can hit the nearest exposed enemy within 1 tile of it that the shooter has a line of fire to. When a soldier cannot fire, a `no_fire` event says why, once.
- **Overwatch** engages only spotted enemies inside a 90 degree arc centered on the line from each soldier to the ordered point, with the 1.2 accuracy factor. It holds position.
- **Assault** runs in (stance stand) and, for any enemy within 2.5 tiles (5 m) in line of sight, makes a close assault instead of firing: kill chance = 0.8 x the better of the target's status factor (pinned 1, shaken 0.5, alert or wounded 0.1) and its exposure from the attacker's side (1 - directional cover) x the attacker's suppression factor. One attempt per second; a success does 100 damage. This is CLAUDE.md's "high kill chance only if the target is pinned or exposed from the attacker's direction".
- **Grenades** (`grenade.js`, numbers in `weapons.json` and `balance.grenade`): the GRN fires 40 mm (30-150 m, needs a line of fire, 8 rounds) if he can, otherwise the closest soldier who can reach it throws a hand grenade (up to 30 m, no line of fire needed, 2 each). Flight: hand 1.5 s, 40 mm range / 76 m/s. Scatter: up to floor(range / 50 m) tiles in x and y, rolled at launch. Blast: hit chance 0.9 / 0.5 / 0.2 within 1 / 2 / 3 tiles, times (1 - the soldier's directional cover from the impact), 60 damage; full walls between impact and soldier shield completely; suppression 70 at the impact falling to 0 at 5 tiles. **It hurts everyone, own soldiers included**; the preview warns DANGER CLOSE for own soldiers within 6 m plus scatter.
- **Preview = sim:** `sim/predict.js` applies the pending orders to a copy of the state and calls the sim's own fire decision (`decideActions`, split out of `resolveFire`) to get each soldier's first action. Ammo duration, suppression per second, route exposure, grenade landing time and close assault odds are computed from the same sim rules. `tests/preview.test.js` checks each prediction against an actual sim run.
- **The preview only uses what the side knows:** its own soldiers, its contacts (status only for spotted ones; suspected assumed crouched and alert). It never says whether an unseen enemy is at a suppress point; a test checks the preview is identical with and without a hidden enemy there.
- **Route exposure** = tiles of the leader's route with no concealment where a known contact has clear, not partial, line of sight to a soldier in the move's stance.
- **Event log times** use the sim clock: an event in tick k is shown at (k + 1) x 0.5 s, matching the preview's times. Orders show at 0.0 s.
- **Balance is not tuned yet (Milestone 7).** Early runs: a scripted frontal assault on the training map never wins; a crude scripted fix-and-flank does not win yet either, though it costs OPFOR far more. Two likely causes to tune: OPFOR rifle fire at 70-100 m is very lethal against crouched soldiers in the open, and one suppress point covers only about 2 tiles while a dug-in fireteam is spread over 10.

---

# Hex redesign (2026-10-08)

The user found the real-time WEGO version did not work as intended and asked for: traditional hexes, dice for hit resolution, orders reduced to move / fire / fast move (fire on an unobserved hex is suppression, firing at or moving into an adjacent hex is an assault), and 50 m hexes, with Take That Hill as inspiration. Everything above this line describes the first version, kept for history; it is in git up to `acfdbe8`.

Answers to the follow-up questions:

- **Turns:** alternating activations, one fireteam at a time.
- **Counters:** a fireteam of 4 (TL, AR, GRN, RFL). BLUFOR squad = ALPHA + BRAVO.
- **Dice:** one d6 per firing soldier against a target number; odds shown before, rolls shown after.
- **Kept:** fog of war, suppression states (shaken, pinned), the odds preview. **Dropped at first:** directional cover (restored later the same day as hexside cover, see below).
- takethathill.com could not be fetched from the cloud environment (network policy), so its rules were not copied; the design follows the user's description.

## Hex milestone 2: map, counters, activations, movement

- **Grid:** pointy-top hexes, "odd-r" offset coordinates `{col, row}` in maps and state (odd rows shifted half a hex right), converted to cube coordinates for distance, neighbors and lines.
- **Terrain table** in `balance.json` (`terrain`): `move` is `normal`, `rough` (a fast move must stop on entering) or `impassable`.
- **Stacking:** one fireteam per hex, any side. Moving into an enemy hex will be an assault (milestone 5); until then it is rejected.
- **Initiative:** BLUFOR activates first every turn. Passing counts as that team's activation.
- **Fast move:** a path of up to `movement.fastMoveHexes` (2) adjacent hexes; entering rough terrain ends it, so a rough hex can only be the last one. The team is exposed until its own next activation (or the end of the next turn's activation of it).
- **Pinned teams** cannot move; they can still fire (milestone 4) or pass.
- **OPFOR** passes on all its activations until fire (milestone 4) and the AI (milestone 6) exist.
- **Squad leader (user request, same day):** an SL counter (`kind: "leader"`, one man) that can share a hex with one fireteam and has a **Rally** action: one suppressed or pinned friendly team within `rally.rangeHexes` (1: his hex or adjacent) rolls a d6, and on `rally.succeedOn` (3+) improves one step. Rally is the SL's activation; a pinned SL cannot rally. Only BLUFOR has an SL on the training map.
- **Statuses (user request):** ok, **suppressed** (cannot move, can fire), **pinned** (cannot move, cannot fire). "Shaken" from the first version is gone.
- **Recovery without the SL:** at the start of each turn every suppressed or pinned unit rolls a d6 and improves one step on `status.recoverOn` (5+). Kept so a team far from the SL is not stuck forever; the SL's 3+ is the reliable way.
- **Stacking at start:** a map may start the SL in the same hex as a fireteam.
- **Moved units cannot fire that turn (user request):** a `moved` flag is set by Move and Fast move and cleared at the start of the next turn. `mayFire()` already refuses fire for moved or pinned units; the Fire action (milestone 4) and any later reaction fire use it.
- **Directional cover is back, on hexsides (user request).** Map entries `hexsides: [{ hex, sides, feature }]`; features in `balance.hexsides`: wall (6+, shared by both hexes), hedge (5+, shared), parapet (6+, its trench hex only). Cover against a shot = the better of the hex's terrain and the feature on the side facing the shooter (`sidesFacing`: the side closest to the line between hex centers; exactly through a corner, both sides and the better one counts). Trench terrain itself drops to 5+ so the parapet (6) is what makes the front strong; from the flank the trench is 5+.
- **Training map:** the OPFOR trench has parapets on its SW and SE sides (facing BLUFOR), the farm has a wall on its south sides, and there is a short hedge by the road.
- **Orders for the whole side (user request, replaces alternating activations).** Each turn the initiative side (BLUFOR) plans one order per unit and commits; `commitOrders` carries them out in the order given (a replaced order keeps its place), then every unit left without an order holds. Then OPFOR commits its orders the same way and the turn ends. Planning checks each order against `projectOrders` of the ones before it: moves are applied, dice orders (rally) only mark the unit as having acted, because their result is unknown. An order that fails at execution is reported (`rejected`) and the unit holds; the commit button refuses a plan that already fails the planning check. OPFOR's placeholder gives no orders (all hold).

## Hex milestone 3: line of sight and fog

- **Line of sight** (`los.js`): hex center to hex center. Terrain with `blocksLos` (woods, buildings) blocks when it is in between; the observer's and target's own hexes never block, so units see out of and into woods. Hexside features with `blocksLos` (hedge) block where the line crosses them, unless the hedge belongs to the observer's or the target's hex (a unit at the hedgerow sees over it). Walls and parapets do not block. Range `vision.maxRangeHexes` (12, 600 m).
- **Edge ties:** a line running exactly along hex edges is drawn both ways (two opposite nudges); sight is clear if either is. Lines are always drawn from the lower hex (row, then column) so floating-point rounding cannot make a -> b differ from b -> a; symmetry is tested over 3000 random pairs.
- **Spotting needs no dice.** An enemy is spotted if a unit of the side has line of sight and the enemy is in non-concealing terrain, or within `vision.spotWithinHexes` (1: adjacent), or exposed (fast moved), or `fired` this turn (the flag is set by fire in milestone 4). Same rules for both sides.
- **Contacts** live in `state.contacts[side][enemyId] = { level, pos, turn }` and are updated after every action and at the turn change. A spotted enemy that stops being spotted becomes **suspected** at its last known hex. A suspected contact is dropped when a unit of the side is within `spotWithinHexes` of that hex with line of sight and the enemy is not there (anyone there would have been spotted), or after `vision.suspectedTurns` (2) turns. First version dropped it as soon as the hex was seen from afar, which made a team walking into the scrub next door vanish instead of leaving a "?".
- **UI:** only spotted OPFOR is drawn; suspected contacts are a dashed "?" box; the header counts contacts; the log only tells BLUFOR what it knows (no OPFOR holds or unseen moves, only BLUFOR's own contact events). V shades the hexes the selected unit cannot see from where its planned order puts it. Move previews say whether the destination is in line of sight of a known enemy and whether the unit will be seen there. `?reveal=1` in the URL draws unseen OPFOR faintly and says DEBUG in the header.
- **Controls (user request):** left click a unit to select it; with a unit selected, left click a hex to give its order, the distance deciding the order: a next hex is a move (green), a hex two away a fast move (orange), and for the SL a suppressed or pinned team next to him is a rally (blue). A hex the selected unit can be ordered to takes the click even if a friendly unit stands there (so the SL can join a team); other clicks on own units select them, and clicking a shared hex again switches between team and SL. Right click (without dragging) or Esc deselects; giving an order also deselects. The Move / Fast move / Rally mode buttons and the M / R / L keys are gone.
