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
