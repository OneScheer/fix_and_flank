# Decisions

Rules that were ambiguous, and the simplest option picked.

## Hitpoints
- Every soldier has `soldier.hpMax` hitpoints (default 3, in `balance.json`).
- Health status comes from hitpoints: full = active, some lost = wounded, 0 = down.

## Suppression states
- Two states shown on the map: **suppressed** at `suppression.suppressed` (40) and **pinned** at `suppression.pinned` (70). Pinned is the worse state.
- "Suppressed" replaces the name "shaken" from CLAUDE.md section 5. Same threshold, same effect (accuracy penalty).
- A team counter shows the worst suppression level among its soldiers who are not down. Commands go to teams, so one pinned soldier holds up the team.

## Team counters
- NATO-style friendly infantry frame (blue rectangle with an X), fireteam echelon mark above, team letter to the right.
- One pip group per soldier under the counter, in roster order (TL, AR, GR, RFL). Filled pip = hitpoint left, hollow = lost.
- Badge on the top-right corner: amber with one chevron = suppressed; dark red with two chevrons = pinned, and the frame is hatched.
- The counter sits on the centre of the team's living soldiers.

## Fire markers
- Built from the turn's `fired` events (`{ type, team, from, target }`). One marker per team and target tile.
- Drawn as a crosshair on the target tile, tagged with the team letter, with a dashed line back to the shooter.
