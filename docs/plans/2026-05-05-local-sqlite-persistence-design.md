# Local SQLite Persistence Layer — Design

**Date**: 2026-05-05
**Author**: gabcinder2004 (via Claude)
**Status**: design accepted, ready for plan + implementation

## Context & motivation

The user is forking wowarenalogs to build a personal arena analytics dashboard for himself and his arena buddies. The fork must:

- Persist match history locally (no Google Cloud dependency)
- Reach feature parity with the existing app (History list, Combat Report, etc.)
- Provide a foundation for new analytics features in Phase 2 (win rates vs comp, average DPS/HPS, CC duration distributions, trends)

Today the prod app is cloud-coupled in three ways:
1. `uploadCombatAsync` pushes every parsed combat to a GCS bucket (`combatUploadSignatureHandler.ts`).
2. `useGetMyMatchesQuery` (GraphQL) reads the History list from Firestore.
3. `useCombatFromStorage` fetches raw `WoWCombatLog-*.txt` per match from GCS and re-parses on the client.

We will replace all three with a local SQLite store, mirroring (3)'s "store raw text, parse on view" behavior.

## Goals

- **Phase 1 — parity**: existing features (History, Combat Report) work identically against local SQLite, with no cloud dependency.
- **Phase 2 — analytics**: new dashboard surfaces queries against the local store.

## Non-goals (Phase 1)

- Cloud auth, profile, search, library, stats pages — out of scope; they're cloud features irrelevant to a personal fork. Hide nav or leave broken; revisit if needed.
- Video recording for backfilled matches — OBS only records during live play; offline-scanned history will have no video. Acceptable.
- Sharing data between users — pure single-machine personal use.

## Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Personal-only, single machine** | User's stated scope. |
| 2 | **Bootstrap from existing logs + persist incrementally** | User has 1-2 days of disk-resident logs; backfill those once, then capture forever. |
| 3 | **Store summary row + raw log slice** (Option 2 from brainstorm) | Mirrors prod's exact code path (`useCombatFromStorage` re-parses raw text on view); smallest storage that preserves full feature parity. |
| 4 | **better-sqlite3 in Electron main, exposed via nativeBridge module** | Matches existing IPC pattern (`logsModule`, `obsModule`, `fsModule`); SQL is the right query language for the analytics workload; native rebuilds already handled by `electron-builder install-app-deps`. |
| 5 | **DB lives at `app.getPath('userData')/matches.db`** | Standard Electron user-data location; co-located with existing IndexedDB folder. |
| 6 | **Match id = parser's existing md5-derived id** | Re-importing the same log slice is automatically a no-op via `INSERT OR IGNORE`. |
| 7 | **Phased delivery**: parity first, analytics second | Avoids building features on a foundation we haven't verified with the existing app. |

## Architecture

```
┌──────────────────────────────────────┐         ┌────────────────────────┐
│ Electron Main Process                │         │ Renderer (Next.js)     │
│                                      │         │                        │
│   logsModule  ──new combat──┐        │         │  useLocalCombats       │
│                              ▼       │  IPC    │     (live, in-memory)  │
│   dbModule (better-sqlite3) │        │ ◄─────► │                        │
│   ├─ matches.db             │        │         │  useMatchesFromDb      │
│   ├─ insertMatch()          │        │         │     ↳ /history page    │
│   ├─ getMatchesSince()      │        │         │                        │
│   ├─ getMatchById()         │        │         │  useCombatFromDb       │
│   └─ getRawSlice(id)        │        │         │     ↳ /match page      │
│                              ▲       │         │                        │
│   bootstrapScanner ─────────┘        │         │                        │
│   (first-run + on-demand rescan)     │         │                        │
└──────────────────────────────────────┘         └────────────────────────┘
```

## Data model

```sql
CREATE TABLE match_summary (
  -- identity
  id              TEXT PRIMARY KEY,        -- parser md5-derived id
  data_type       TEXT NOT NULL,           -- 'ArenaMatch'|'ShuffleRound'|'ShuffleMatch'|'BattlegroundCombat'
  shuffle_match_id TEXT,                   -- nullable; links rounds to parent
  sequence_number INTEGER,

  -- when / where
  start_time      INTEGER NOT NULL,        -- ms since epoch
  end_time        INTEGER NOT NULL,
  duration_seconds REAL NOT NULL,
  bracket         TEXT NOT NULL,
  zone_id         TEXT,
  wow_version     TEXT NOT NULL,
  timezone        TEXT NOT NULL,

  -- outcome
  result          INTEGER,                 -- CombatResult enum (nullable for BG)
  winning_team_id TEXT,
  player_team_id  TEXT,
  player_id       TEXT,
  player_spec     TEXT,
  player_class    TEXT,

  -- aggregated stats
  team0_specs     TEXT,                    -- '70/71/264' sorted joined
  team1_specs     TEXT,
  team0_mmr       INTEGER,
  team1_mmr       INTEGER,
  player_damage   INTEGER,
  player_healing  INTEGER,
  player_deaths   INTEGER,

  -- bookkeeping
  source_file     TEXT,                    -- WoWCombatLog filename
  ingested_at     INTEGER NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_match_summary_start         ON match_summary(start_time DESC);
CREATE INDEX idx_match_summary_bracket_start ON match_summary(bracket, start_time DESC);
CREATE INDEX idx_match_summary_shuffle_match ON match_summary(shuffle_match_id);

CREATE TABLE match_raw (
  id          TEXT PRIMARY KEY REFERENCES match_summary(id) ON DELETE CASCADE,
  raw_text    TEXT NOT NULL,
  raw_bytes   INTEGER NOT NULL,
  inserted_at INTEGER NOT NULL
);

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- seed: ('version', '1'), ('bootstrapped_at', null until first bootstrap completes)
```

### Schema notes

- **Comp specs as joined strings, not a join table**: deferred until Phase 2 demonstrates need. `LIKE '%70%'` queries are adequate for early dashboards.
- **Precomputed player aggregates** (`player_damage`, etc.) make the History list scroll fast without cracking blobs.
- **`schema_version` on every row** allows targeted re-derivation when columns are added.

## Write path

The renderer's `LocalCombatsContext` (`packages/web/hooks/LocalCombatsContext/index.tsx`) already receives every parsed combat via `handleNewCombat`, `handleSoloShuffleEnded`, `handleSoloShuffleRoundEnded`. Today it calls `uploadCombatAsync(combat, auth.battlenetId)` (lines 248, 305).

For the fork:

- Replace `uploadCombatAsync` calls with `window.wowarenalogs.db.insertMatch(combat)`.
- The IPC handler in `dbModule` derives the summary fields, extracts the raw slice from `combat.rawLines.join('\n')`, and runs an `INSERT OR IGNORE` transaction over both tables.
- If the renderer wants both behaviors during transition, we can keep `uploadCombatAsync` behind the existing `shouldSkipUpload` flag — but for the personal fork, we'll just remove it.

## Read path

Two new hooks replace the cloud-backed ones:

```ts
// packages/shared/src/hooks/useMatchesFromDb.ts
export function useMatchesFromDb(filter?: { since?: Date; bracket?: string }) {
  return useQuery(['matches', filter], () =>
    window.wowarenalogs.db.getMatchesSince(filter?.since?.getTime() ?? 0, filter?.bracket),
  );
}

// packages/shared/src/hooks/useCombatFromDb.ts
export function useCombatFromDb(matchId: string, roundId?: string) {
  return useQuery(['combat', matchId, roundId], async () => {
    const { rawText, wowVersion, timezone } = await window.wowarenalogs.db.getRawSlice(matchId);
    const results = Utils.parseFromStringArray(rawText.split('\n'), wowVersion, timezone);
    return (
      results.arenaMatches.at(0) ??
      (roundId ? results.shuffleMatches[0]?.rounds[parseInt(roundId) - 1] : undefined)
    );
  });
}
```

The `useCombatFromDb` body is intentionally near-identical to `useCombatFromStorage` — same `Utils.parseFromStringArray` call, same return shape. `<CombatReport>` does not change.

The History page (`packages/web/app/(main)/history/page.tsx`) swaps `useGetMyMatchesQuery` for `useMatchesFromDb`. The match detail page (`packages/web/app/(main)/match/page.tsx`) keeps `<CombatReportFromStorage>` but we add (or rewrite) it to use `useCombatFromDb`.

## Bootstrap

On main-process startup, `dbModule` checks `schema_meta.bootstrapped_at`. If null:

1. Read each `WoWCombatLog-*.txt` in the configured WoW Logs folder (from `wowInstallations` config).
2. Stream each through `WoWCombatLogParser`, hooking the same callbacks `logsModule` uses.
3. For each emitted combat, call `insertMatch` (transactional, batched).
4. Set `schema_meta.bootstrapped_at = now`.

The bootstrap runs in a background thread so the UI doesn't block. We surface progress via a new IPC event (`bootstrap_progress`) so a one-time first-run modal can show "Importing X of Y matches…".

For ongoing rescans (e.g., user shares a Dropbox folder with buddies), expose `db.rescanLogsFolder(path)` — same code path, but it's a no-op for matches whose ids already exist (`INSERT OR IGNORE`).

## IPC API surface (dbModule)

```ts
@nativeBridgeModule('db')
export class DbModule extends NativeBridgeModule {
  @moduleFunction()
  insertMatch(combat: AtomicArenaCombat | IShuffleMatch | IBattlegroundCombat): Promise<{ inserted: boolean }>;

  @moduleFunction()
  getMatchesSince(sinceMs: number, bracket?: string): Promise<MatchSummaryRow[]>;

  @moduleFunction()
  getMatchById(id: string): Promise<MatchSummaryRow | null>;

  @moduleFunction()
  getRawSlice(id: string): Promise<{ rawText: string; wowVersion: WowVersion; timezone: string } | null>;

  @moduleFunction()
  getDbStats(): Promise<{ totalMatches: number; totalRawBytes: number; oldest: number; newest: number }>;

  @moduleFunction()
  rescanLogsFolder(folderPath: string): Promise<{ scanned: number; inserted: number }>;

  @moduleEvent()
  bootstrapProgress(payload: { current: number; total: number; phase: string }): void;
}
```

Generated preload bridge (`gen:app:preload` script) gives the renderer typed `window.wowarenalogs.db.*` access automatically.

## Error handling

- **DB open failure**: on first open, retry with a backup-then-recreate fallback; surface a Sentry error and continue with an in-memory db so the app at least boots.
- **Insert failure on a single match**: log + continue; don't fail the whole bootstrap.
- **Corrupted raw slice / parser error on detail view**: render `<ErrorPage>` (existing component used by `CombatReportFromStorage`) with a "Re-parse failed — raw log preserved" message.
- **Schema version mismatch on startup**: run migrations from `meta.version` → current; refuse to open if migration fails (better than corrupting).

## Testing

- **Unit**: `packages/app/src/nativeBridge/modules/dbModule/dbModule.test.ts` exercises insert/read with the existing parser fixtures from `packages/parser/test/testlogs/`.
- **Integration**: a small fixture WoWCombatLog file gets bootstrapped; we verify the History list and Combat Report render against the local DB.
- **Manual smoke test** (the Phase 1 "definition of done"):
  1. Run `npm run dev:app` against a populated WoW `Logs/` folder.
  2. First boot: bootstrap progress modal completes.
  3. `/history` shows every match from the logs, identical fields to prod.
  4. Click any match: full Combat Report renders identically to prod.
  5. Restart the app: history persists.
  6. Queue and finish a new arena: it appears in `/history` automatically.

## Phase 2 expansion path (out of scope now)

- Add `match_players` table (one row per player per match) for normalized per-class/spec analytics.
- Pre-compute and store CC durations, kill target, first-blood, etc. in summary or in a derived `match_metrics` table.
- New `/dashboard` route with charts: win rate over time, win rate vs comp matrix, DPS/HPS distributions, CC pressure heatmaps.

Both expansions are non-breaking: `ALTER TABLE` adds columns; new tables key off `match_summary.id`.

## Open questions to address during implementation

- better-sqlite3 ABI compatibility with Electron 38 — verify on first install; fall back to `node-sqlite3-wasm` if it doesn't rebuild cleanly.
- Whether to keep `uploadCombatAsync` behind the existing `skipUploads` flag during dev or excise entirely (lean toward excise for the fork).
- Whether to expose `rescanLogsFolder` in Phase 1 UI or wait for Phase 2.
