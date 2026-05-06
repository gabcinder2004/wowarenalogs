# Phase 2 — Personal Analytics Dashboard

**Status**: ready to brainstorm. Phase 1 (local SQLite persistence parity) is complete and shipped on `feat/local-sqlite-persistence`.

## How to use this doc

Open a new Claude Code session in this repo. First message:

> Read `docs/plans/2026-05-05-phase2-analytics-kickoff.md` and `docs/plans/2026-05-05-local-sqlite-persistence-design.md`. Then invoke the brainstorming skill (`superpowers:brainstorming`) to start designing the Phase 2 analytics dashboard.

The brainstorming skill will ask one question at a time and produce a design doc. After that comes a writing-plans pass and subagent-driven-development execution. Same workflow that built Phase 1.

**Subagent model preference: use sonnet** (`model: "sonnet"` on Agent tool calls) — Phase 1 found it sufficient and dramatically faster/cheaper than opus.

## Context: why this exists

Personal fork of wowarenalogs (https://github.com/gabcinder2004/wowarenalogs). Single-machine, no cloud. The user (gabcinder2004) wants an arena analytics dashboard for himself + arena buddies.

Originally requested feature set, in user's own words:

> Over the last X amount of days worth of arenas, look at the different types of analytics — win rates versus certain comps or classes, what we averaged in damage or heals, statistics around average CC durations, trending data, etc.

Phase 1's job was groundwork: replace the cloud-backed match list and detail with a local SQLite store, with bit-for-bit parity. Done. Phase 2's job is to design and build the analytics surface that sits on top.

## What Phase 1 gives you (the foundation)

Local SQLite at `app.getPath('userData')/matches.db`. Two tables, exposed via a typed `dbModule` IPC.

### `match_summary` — flat per-match row

Already populated for every arena match, shuffle round, and battleground (BG) the user has played. Columns (camelCase as exposed via IPC):

```
id, dataType, shuffleMatchId, sequenceNumber,
startTime, endTime, durationSeconds, bracket, zoneId, wowVersion, timezone,
result, winningTeamId, playerTeamId, playerId, playerSpec, playerClass,
team0Specs, team1Specs, team0Mmr, team1Mmr,
playerDamage, playerHealing, playerDeaths,
sourceFile, ingestedAt, schemaVersion
```

Notable shape choices to know:

- `team0Specs`/`team1Specs` are **joined strings** like `"70/71/264"` (sorted, slash-separated). Easy `LIKE`-able for "did we play vs Holy Paladin?" but not normalized. Phase 2 may want a `match_players` join table.
- `playerDamage`/`playerHealing` are **whole-match totals** for the recording player only. Per-player stats for teammates/opponents are NOT pre-computed.
- `result` is the parser's `CombatResult` enum: `0=Unknown, 1=Draw, 2=Lose, 3=Win`.
- BG rows have `result=NULL` and empty team specs (BG combat shape lacks those fields).
- Indexes: `start_time DESC`, `(bracket, start_time DESC)`, `shuffle_match_id`.

### `match_raw` — full log slice

For drill-down. Holds the raw `WoWCombatLog-*.txt` lines from match-start to match-end. Re-parsed on demand by `useCombatFromDb` to reconstruct a full `AtomicArenaCombat` for the Combat Report. Phase 2 analytics that need event-level data (e.g., CC durations, kill targets) should derive on ingest, not re-parse on every query.

### Read API surface

- `useMatchesFromDb({ since?, bracket? })` — react-query hook returning typed rows.
- `useCombatFromDb(matchId, roundId?)` — re-parses a raw slice, returns full combat object.
- Direct IPC: `window.wowarenalogs.db.{getMatchesSince, getMatchById, getRawSlice, getDbStats, runBootstrap, isBootstrapped, insertMatch}`.

### Write path

- Live capture: `LocalCombatsContext` calls `db.insertMatch` after every match completes.
- Bootstrap: `/debug` page has a "Bootstrap from WoW Logs folder" button that walks the user's actual logs (~70 records / 333MB / ~7s) and bulk-inserts.
- `INSERT OR IGNORE` on `id` (parser's md5-derived) makes everything idempotent.

## Phase 2 design questions to resolve in brainstorming

Pick what to build first; these aren't all in scope. List, not order:

1. **What analytics ship in v1?** Win rate vs comp, avg DPS/HPS, CC duration distributions, trends — pick a subset; YAGNI the rest.
2. **What time windows?** Last N days? Last N matches? Custom date range? Per-season?
3. **How do we handle CC duration computation?** It needs the event stream, not just the summary. Options: (a) compute on ingest and store in a new `match_metrics` table, (b) re-parse on demand and cache, (c) only support metrics that are already in `match_summary`.
4. **Per-player or whole-team metrics?** The summary row only has the recording player's damage/healing. For "what's my paladin healer's HPS in 3v3" we'd need per-player rows.
5. **Schema additions vs query-time computation?** A `match_players` table would normalize per-player stats but is a non-trivial migration. A `match_metrics` table for derived per-match scalars is additive.
6. **UI placement.** New `/dashboard` route? Sidebar nav entry? Replaces or supplements `/history`?
7. **Filters as URL state vs ephemeral UI state?**
8. **Export / share?** Out of scope for personal fork? Or simple CSV download for sharing with arena buddies?

## Phase 1 follow-up backlog (deferred fixes)

Worth knowing about but not blockers for Phase 2 design. From the per-task code reviews:

- **Cache prepared statements in `database.ts`** (Task 4 review, I-1). Currently re-prepared per call; saves ~5-15ms per query.
- **Bump `useMatchesFromDb` staleTime from 0 to ~30s** (Task 6 perf finding). The History tab refetches on every navigation; staleness window of 30s makes tab-clicks instant.
- **Hide cloud-only nav/pages** (`/library`, `/profile`, `/search`, `/stats`). They 500 because the fork has no GCP creds. Either delete them or feature-flag them off.
- **`npm install` ABI-mismatch onboarding gotcha** (Task 1 / Task 4). Fresh `npm install` leaves better-sqlite3 at the Node ABI; needs `npx @electron/rebuild` to flip to Electron 38 ABI. The repo's `prepare` script gates electron-builder on `NODE_ENV != 'production'` but the rebuild doesn't always actually fire. Worth a one-line README note or a more robust `prepare` step.
- **Empty-DB UX**: the History page renders blank when no matches are imported yet; would be friendlier to show a "Run bootstrap" empty state.
- **Extract `specToClass` from `useMatchesFromDb.ts`** into the parser package as a proper export — currently duplicated from `CombatData.ts`'s switch.
- **Drop `window as unknown as ...` cast in `useMatchesFromDb`** (left over; the equivalent in `useCombatFromDb` was already cleaned up).

Some of these (perf staleTime, hide cloud pages) might naturally land alongside Phase 2 since the dashboard is on the fork's main UX path.

## Repo / branch state

- Fork: https://github.com/gabcinder2004/wowarenalogs
- Branch with all Phase 1 work: `feat/local-sqlite-persistence` (17 commits)
- Remotes: `origin` → fork, `upstream` → wowarenalogs/wowarenalogs
- Phase 1 design doc: `docs/plans/2026-05-05-local-sqlite-persistence-design.md`
- Phase 1 implementation plan: `docs/plans/2026-05-05-local-sqlite-persistence.md`
- This kickoff: `docs/plans/2026-05-05-phase2-analytics-kickoff.md`
- Offline scanner (handy for Phase 2 prototyping against real data): `packages/parser/scripts/scanLogs.js`

## Smoke-test confirmation

Phase 1 was manually verified end-to-end on the user's machine: bootstrap imported ~80 matches across multiple brackets and BGs; History list rendered correctly; clicking a 2v2 match opened the full Combat Report (Summary, Players, Performance, CC & Kicks, Death, Curves, Replay, Timeline, Video tabs all functional). DB persists across app restarts. New live matches from `LocalCombatsContext` auto-persist.

Known minor perf observation: tab-clicking History has a ~1s perceived delay (~285ms IPC + ~700ms `<CombatStubList>` render). Acceptable for now; the staleTime bump in the follow-up backlog kills most of it.
