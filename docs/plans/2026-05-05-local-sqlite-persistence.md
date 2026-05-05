# Local SQLite Persistence Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the cloud-backed match list and match-detail data paths with a local SQLite store, so a forked wowarenalogs runs fully offline against the user's own combat logs while keeping every existing feature working.

**Architecture:** Add a `better-sqlite3`-backed `dbModule` in the Electron main process, exposed to the renderer via the existing nativeBridge IPC pattern. Persist `match_summary` (flat fields) + `match_raw` (raw log slice text). Bootstrap once from `WoWCombatLog-*.txt` files in the user's WoW Logs folder, then capture incrementally. Replace `useGetMyMatchesQuery` with `useMatchesFromDb`, and `useCombatFromStorage` with `useCombatFromDb` (same parse-on-view behavior as prod, just sourced locally). Full design in `docs/plans/2026-05-05-local-sqlite-persistence-design.md`.

**Tech Stack:** Electron 38, TypeScript, better-sqlite3 11.x, Next.js 14 (renderer), `@wowarenalogs/parser`, react-query.

**Definition of done (Phase 1):**
1. `npm run dev:app` boots without GCP credentials.
2. `/history` lists every arena/shuffle from your WoW logs, sourced from local SQLite.
3. Clicking a match renders the full Combat Report identically to prod.
4. New matches captured during the live session persist to SQLite.
5. Restarting the app preserves history.

---

## Pre-flight (one time)

### Task 0: Set up an isolated branch / worktree

This plan touches ~10 files across packages. Work it on its own branch.

**Step 1: Create a feature branch**

```bash
git checkout -b feat/local-sqlite-persistence
```

(Or use a worktree if you want to keep `main` checked out elsewhere — see superpowers:using-git-worktrees.)

**Step 2: Verify clean tree**

```bash
git status
```
Expected: "On branch feat/local-sqlite-persistence", "nothing to commit".

---

## Foundation

### Task 1: Install better-sqlite3 in the app package

**Files:**
- Modify: `packages/app/package.json`

**Step 1: Install**

```bash
npm install -w @wowarenalogs/app better-sqlite3@^11
npm install -w @wowarenalogs/app -D @types/better-sqlite3
```

**Step 2: Rebuild native module against Electron's ABI**

```bash
NODE_ENV=production npm run prepare
```
Expected: "completed installing native dependencies" with no errors. If this fails, see "Troubleshooting" at the bottom of this plan.

**Step 3: Smoke-import**

Create a one-off file at `packages/app/scratch-sqlite-check.js`:

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');
console.log(db.prepare('SELECT * FROM t').all());
db.close();
```

Run:

```bash
cd packages/app && node scratch-sqlite-check.js && rm scratch-sqlite-check.js
```
Expected: `[ { id: 1 } ]`. Then delete the file.

**Step 4: Commit**

```bash
git add packages/app/package.json package-lock.json
git commit -m "chore: add better-sqlite3 to app package"
```

---

### Task 2: Add a `match summary` derivation helper in the parser package

This is pure logic with no Electron dependency, so it lives in `@wowarenalogs/parser` where Jest is already configured. It transforms an `AtomicArenaCombat | IShuffleMatch | IBattlegroundCombat` into a flat row matching our schema.

**Files:**
- Create: `packages/parser/src/matchSummary.ts`
- Create: `packages/parser/test/matchSummary.test.ts`
- Modify: `packages/parser/src/index.ts` (re-export)

**Step 1: Write the failing test first**

Create `packages/parser/test/matchSummary.test.ts`:

```ts
import { deriveMatchSummary } from '../src/matchSummary';
import { loadLogFile } from './testLogLoader';

describe('deriveMatchSummary', () => {
  it('extracts core fields from a 3v3 arena match', () => {
    const { combats } = loadLogFile('3v3_tww_1120_reduced.txt');
    expect(combats.length).toBeGreaterThan(0);
    const summary = deriveMatchSummary(combats[0], 'src.txt');

    expect(summary.id).toBe(combats[0].id);
    expect(summary.dataType).toBe('ArenaMatch');
    expect(summary.bracket).toBe(combats[0].startInfo.bracket);
    expect(summary.startTime).toBe(combats[0].startTime);
    expect(summary.endTime).toBe(combats[0].endTime);
    expect(summary.durationSeconds).toBe(combats[0].durationInSeconds);
    expect(summary.team0Specs).toMatch(/\d+(\/\d+)*/);
    expect(summary.team1Specs).toMatch(/\d+(\/\d+)*/);
    expect(summary.sourceFile).toBe('src.txt');
  });

  it('extracts a shuffle round', () => {
    const { shuffleRounds } = loadLogFile('one_solo_shuffle.txt');
    expect(shuffleRounds.length).toBeGreaterThan(0);
    const summary = deriveMatchSummary(shuffleRounds[0], 'src.txt');

    expect(summary.dataType).toBe('ShuffleRound');
    expect(summary.sequenceNumber).toBe(shuffleRounds[0].sequenceNumber);
  });

  it('handles a battleground without result/duration fields', () => {
    const { battlegrounds = [] } = loadLogFile('bg_blitz.txt');
    if (battlegrounds.length === 0) return; // some fixtures don't have BG
    const summary = deriveMatchSummary(battlegrounds[0], 'src.txt');
    expect(summary.dataType).toBe('BattlegroundCombat');
    expect(summary.result).toBeNull();
    expect(summary.durationSeconds).toBeGreaterThanOrEqual(0);
  });
});
```

**Step 2: Run the test to verify it fails**

```bash
cd packages/parser && npx tsdx test --testPathPattern matchSummary
```
Expected: FAIL — "Cannot find module '../src/matchSummary'".

**Step 3: Implement `deriveMatchSummary`**

Create `packages/parser/src/matchSummary.ts`:

```ts
import {
  AtomicArenaCombat,
  IArenaMatch,
  IBattlegroundCombat,
  IShuffleMatch,
  IShuffleRound,
} from './CombatData';
import { CombatUnitType } from './types';

export interface MatchSummaryRow {
  id: string;
  dataType: 'ArenaMatch' | 'ShuffleRound' | 'ShuffleMatch' | 'BattlegroundCombat';
  shuffleMatchId: string | null;
  sequenceNumber: number | null;

  startTime: number;
  endTime: number;
  durationSeconds: number;
  bracket: string;
  zoneId: string | null;
  wowVersion: string;
  timezone: string;

  result: number | null;
  winningTeamId: string | null;
  playerTeamId: string | null;
  playerId: string | null;
  playerSpec: string | null;
  playerClass: string | null;

  team0Specs: string;
  team1Specs: string;
  team0Mmr: number | null;
  team1Mmr: number | null;
  playerDamage: number;
  playerHealing: number;
  playerDeaths: number;

  sourceFile: string | null;
}

const teamSpecs = (combat: AtomicArenaCombat, teamId: string): string =>
  Object.values(combat.units)
    .filter((u) => u.type === CombatUnitType.Player && u.info?.teamId === teamId)
    .map((u) => (u.spec && u.spec !== '0' ? u.spec : `class:${u.class}`))
    .sort()
    .join('/');

function summariseArena(m: IArenaMatch, sourceFile: string | null): MatchSummaryRow {
  const player = Object.values(m.units).find((u) => u.id === m.playerId);
  return {
    id: m.id,
    dataType: 'ArenaMatch',
    shuffleMatchId: null,
    sequenceNumber: null,
    startTime: m.startTime,
    endTime: m.endTime,
    durationSeconds: m.durationInSeconds,
    bracket: m.startInfo.bracket,
    zoneId: m.startInfo.zoneId ?? null,
    wowVersion: m.wowVersion,
    timezone: m.timezone,
    result: m.result,
    winningTeamId: m.endInfo?.winningTeamId ?? null,
    playerTeamId: m.playerTeamId ?? null,
    playerId: m.playerId ?? null,
    playerSpec: player?.spec ?? null,
    playerClass: player?.class ?? null,
    team0Specs: teamSpecs(m, '0'),
    team1Specs: teamSpecs(m, '1'),
    team0Mmr: m.endInfo?.team0MMR ?? null,
    team1Mmr: m.endInfo?.team1MMR ?? null,
    playerDamage: player?.damageOut?.reduce((a, e) => a + (e.amount ?? 0), 0) ?? 0,
    playerHealing: player?.healOut?.reduce((a, e) => a + (e.amount ?? 0), 0) ?? 0,
    playerDeaths: player?.deathRecords?.length ?? 0,
    sourceFile,
  };
}

function summariseShuffleRound(r: IShuffleRound, sourceFile: string | null): MatchSummaryRow {
  const base = summariseArena(r as unknown as IArenaMatch, sourceFile);
  return {
    ...base,
    dataType: 'ShuffleRound',
    sequenceNumber: r.sequenceNumber,
  };
}

function summariseShuffleMatch(m: IShuffleMatch, sourceFile: string | null): MatchSummaryRow {
  return {
    id: m.id,
    dataType: 'ShuffleMatch',
    shuffleMatchId: null,
    sequenceNumber: null,
    startTime: m.startTime,
    endTime: m.endTime,
    durationSeconds: m.durationInSeconds,
    bracket: m.startInfo.bracket,
    zoneId: m.startInfo.zoneId ?? null,
    wowVersion: m.wowVersion,
    timezone: m.timezone,
    result: m.result,
    winningTeamId: m.endInfo?.winningTeamId ?? null,
    playerTeamId: null,
    playerId: null,
    playerSpec: null,
    playerClass: null,
    team0Specs: '',
    team1Specs: '',
    team0Mmr: m.endInfo?.team0MMR ?? null,
    team1Mmr: m.endInfo?.team1MMR ?? null,
    playerDamage: 0,
    playerHealing: 0,
    playerDeaths: 0,
    sourceFile,
  };
}

function summariseBg(bg: IBattlegroundCombat, sourceFile: string | null): MatchSummaryRow {
  return {
    id: bg.id,
    dataType: 'BattlegroundCombat',
    shuffleMatchId: null,
    sequenceNumber: null,
    startTime: bg.startTime,
    endTime: bg.endTime,
    durationSeconds: (bg.endTime - bg.startTime) / 1000,
    bracket: 'battleground',
    zoneId: bg.zoneInEvent?.instanceId ? String(bg.zoneInEvent.instanceId) : null,
    wowVersion: bg.wowVersion,
    timezone: bg.timezone,
    result: null,
    winningTeamId: null,
    playerTeamId: null,
    playerId: null,
    playerSpec: null,
    playerClass: null,
    team0Specs: '',
    team1Specs: '',
    team0Mmr: null,
    team1Mmr: null,
    playerDamage: 0,
    playerHealing: 0,
    playerDeaths: 0,
    sourceFile,
  };
}

export function deriveMatchSummary(
  combat: IArenaMatch | IShuffleRound | IShuffleMatch | IBattlegroundCombat,
  sourceFile: string | null,
): MatchSummaryRow {
  switch (combat.dataType) {
    case 'ArenaMatch':
      return summariseArena(combat, sourceFile);
    case 'ShuffleRound':
      return summariseShuffleRound(combat, sourceFile);
    case 'ShuffleMatch':
      return summariseShuffleMatch(combat, sourceFile);
    case 'BattlegroundCombat':
      return summariseBg(combat, sourceFile);
  }
}
```

NOTE: Inspect `ICombatUnit.damageOut` / `healOut` / `deathRecords` field shapes in `packages/parser/src/CombatUnit.ts` before running. If the field names differ (likely candidates: `damagingActions`, `healingActions`), adapt the reducers. The test will catch any wrong field name.

**Step 4: Re-export from package entrypoint**

Edit `packages/parser/src/index.ts` and append after the existing exports:

```ts
export { deriveMatchSummary } from './matchSummary';
export type { MatchSummaryRow } from './matchSummary';
```

**Step 5: Run tests**

```bash
cd packages/parser && npx tsdx test --testPathPattern matchSummary
```
Expected: PASS (3 tests). If `playerDamage` / `playerHealing` are 0 because the field names were wrong, fix and re-run.

**Step 6: Rebuild parser dist (so `app` can use the new export at runtime)**

```bash
cd packages/parser && npm run build
```

**Step 7: Commit**

```bash
git add packages/parser/src/matchSummary.ts packages/parser/test/matchSummary.test.ts packages/parser/src/index.ts packages/parser/dist
git commit -m "feat(parser): add deriveMatchSummary for flat per-match summary rows"
```

---

### Task 3: Scaffold the empty `dbModule`

Create the module class registered in the bridge. No DB code yet — just the IPC plumbing so the renderer can see it via `window.wowarenalogs.db`.

**Files:**
- Create: `packages/app/src/nativeBridge/modules/dbModule/index.ts`
- Modify: `packages/app/src/nativeBridge/registry.ts`

**Step 1: Create the module skeleton**

Create `packages/app/src/nativeBridge/modules/dbModule/index.ts`:

```ts
import { BrowserWindow } from 'electron';

import { moduleFunction, NativeBridgeModule, nativeBridgeModule } from '../../module';

@nativeBridgeModule('db')
export class DbModule extends NativeBridgeModule {
  @moduleFunction()
  public async ping(_mainWindow: BrowserWindow): Promise<string> {
    return 'pong';
  }

  public override onRegistered(_mainWindow: BrowserWindow): void {
    // DB will be opened in a later task
  }
}
```

**Step 2: Register the module**

Edit `packages/app/src/nativeBridge/registry.ts`. After line 7 (`import { LogsModule }...`), add:

```ts
import { DbModule } from './modules/dbModule';
```

After line 145 (`nativeBridgeRegistry.registerModule(ObsModule);`), add:

```ts
nativeBridgeRegistry.registerModule(DbModule);
```

**Step 3: Regenerate the preload bridge**

```bash
cd packages/app && npm run gen:app:preload
```
Expected: no errors; `packages/app/src/preloadApi.ts` and `packages/app/src/windowApi.d.ts` now contain a `db` entry.

**Step 4: Verify regeneration**

```bash
grep -n '"db":' packages/app/src/preloadApi.ts
grep -n 'ping' packages/app/src/windowApi.d.ts
```
Expected: hits in both files.

**Step 5: Commit**

```bash
git add packages/app/src/nativeBridge/modules/dbModule/ packages/app/src/nativeBridge/registry.ts packages/app/src/preloadApi.ts packages/app/src/windowApi.d.ts
git commit -m "feat(app): scaffold dbModule with ping IPC method"
```

---

## DB layer

### Task 4: Implement schema + DB open

**Files:**
- Create: `packages/app/src/nativeBridge/modules/dbModule/schema.sql`
- Create: `packages/app/src/nativeBridge/modules/dbModule/database.ts`
- Modify: `packages/app/src/nativeBridge/modules/dbModule/index.ts`

**Step 1: Create schema file**

Create `packages/app/src/nativeBridge/modules/dbModule/schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS match_summary (
  id              TEXT PRIMARY KEY,
  data_type       TEXT NOT NULL,
  shuffle_match_id TEXT,
  sequence_number INTEGER,

  start_time      INTEGER NOT NULL,
  end_time        INTEGER NOT NULL,
  duration_seconds REAL NOT NULL,
  bracket         TEXT NOT NULL,
  zone_id         TEXT,
  wow_version     TEXT NOT NULL,
  timezone        TEXT NOT NULL,

  result          INTEGER,
  winning_team_id TEXT,
  player_team_id  TEXT,
  player_id       TEXT,
  player_spec     TEXT,
  player_class    TEXT,

  team0_specs     TEXT,
  team1_specs     TEXT,
  team0_mmr       INTEGER,
  team1_mmr       INTEGER,
  player_damage   INTEGER,
  player_healing  INTEGER,
  player_deaths   INTEGER,

  source_file     TEXT,
  ingested_at     INTEGER NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_match_summary_start         ON match_summary(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_match_summary_bracket_start ON match_summary(bracket, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_match_summary_shuffle_match ON match_summary(shuffle_match_id);

CREATE TABLE IF NOT EXISTS match_raw (
  id          TEXT PRIMARY KEY REFERENCES match_summary(id) ON DELETE CASCADE,
  raw_text    TEXT NOT NULL,
  raw_bytes   INTEGER NOT NULL,
  inserted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '1');
```

**Step 2: Implement DB wrapper**

Create `packages/app/src/nativeBridge/modules/dbModule/database.ts`:

```ts
import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

import type { MatchSummaryRow } from '@wowarenalogs/parser';

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const userData = app.getPath('userData');
  const dbPath = path.join(userData, 'matches.db');
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schemaSql);
  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function getDbStats(): { totalMatches: number; totalRawBytes: number; oldest: number | null; newest: number | null } {
  const db = getDb();
  const summary = db.prepare('SELECT COUNT(*) as c, MIN(start_time) as o, MAX(start_time) as n FROM match_summary').get() as { c: number; o: number | null; n: number | null };
  const raw = db.prepare('SELECT COALESCE(SUM(raw_bytes),0) as b FROM match_raw').get() as { b: number };
  return { totalMatches: summary.c, totalRawBytes: raw.b, oldest: summary.o, newest: summary.n };
}

export function insertMatch(summary: MatchSummaryRow, rawText: string): { inserted: boolean } {
  const db = getDb();
  const now = Date.now();
  const insertSummary = db.prepare(`
    INSERT OR IGNORE INTO match_summary (
      id, data_type, shuffle_match_id, sequence_number,
      start_time, end_time, duration_seconds, bracket, zone_id, wow_version, timezone,
      result, winning_team_id, player_team_id, player_id, player_spec, player_class,
      team0_specs, team1_specs, team0_mmr, team1_mmr, player_damage, player_healing, player_deaths,
      source_file, ingested_at, schema_version
    ) VALUES (
      @id, @dataType, @shuffleMatchId, @sequenceNumber,
      @startTime, @endTime, @durationSeconds, @bracket, @zoneId, @wowVersion, @timezone,
      @result, @winningTeamId, @playerTeamId, @playerId, @playerSpec, @playerClass,
      @team0Specs, @team1Specs, @team0Mmr, @team1Mmr, @playerDamage, @playerHealing, @playerDeaths,
      @sourceFile, @ingestedAt, 1
    )
  `);
  const insertRaw = db.prepare(`
    INSERT OR IGNORE INTO match_raw (id, raw_text, raw_bytes, inserted_at)
    VALUES (?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const r = insertSummary.run({ ...summary, ingestedAt: now });
    if (r.changes === 0) return false;
    insertRaw.run(summary.id, rawText, Buffer.byteLength(rawText, 'utf8'), now);
    return true;
  });
  return { inserted: tx() === true };
}

export function getMatchesSince(sinceMs: number, bracket?: string): unknown[] {
  const db = getDb();
  const stmt = bracket
    ? db.prepare('SELECT * FROM match_summary WHERE start_time >= ? AND bracket = ? ORDER BY start_time DESC')
    : db.prepare('SELECT * FROM match_summary WHERE start_time >= ? ORDER BY start_time DESC');
  return bracket ? stmt.all(sinceMs, bracket) : stmt.all(sinceMs);
}

export function getMatchById(id: string): unknown {
  const db = getDb();
  return db.prepare('SELECT * FROM match_summary WHERE id = ?').get(id) ?? null;
}

export function getRawSlice(id: string): { rawText: string; wowVersion: string; timezone: string } | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT r.raw_text as rawText, s.wow_version as wowVersion, s.timezone
    FROM match_raw r JOIN match_summary s ON s.id = r.id
    WHERE r.id = ?
  `).get(id) as { rawText: string; wowVersion: string; timezone: string } | undefined;
  return row ?? null;
}
```

**Step 3: Wire DB methods into the IPC module**

Replace the contents of `packages/app/src/nativeBridge/modules/dbModule/index.ts` with:

```ts
import type { MatchSummaryRow, WowVersion } from '@wowarenalogs/parser';
import { BrowserWindow } from 'electron';

import { moduleFunction, NativeBridgeModule, nativeBridgeModule } from '../../module';
import * as Database from './database';

@nativeBridgeModule('db')
export class DbModule extends NativeBridgeModule {
  @moduleFunction()
  public async insertMatch(_mainWindow: BrowserWindow, summary: MatchSummaryRow, rawText: string): Promise<{ inserted: boolean }> {
    return Database.insertMatch(summary, rawText);
  }

  @moduleFunction()
  public async getMatchesSince(_mainWindow: BrowserWindow, sinceMs: number, bracket?: string): Promise<unknown[]> {
    return Database.getMatchesSince(sinceMs, bracket);
  }

  @moduleFunction()
  public async getMatchById(_mainWindow: BrowserWindow, id: string): Promise<unknown> {
    return Database.getMatchById(id);
  }

  @moduleFunction()
  public async getRawSlice(_mainWindow: BrowserWindow, id: string): Promise<{ rawText: string; wowVersion: WowVersion; timezone: string } | null> {
    return Database.getRawSlice(id) as { rawText: string; wowVersion: WowVersion; timezone: string } | null;
  }

  @moduleFunction()
  public async getDbStats(_mainWindow: BrowserWindow): Promise<{ totalMatches: number; totalRawBytes: number; oldest: number | null; newest: number | null }> {
    return Database.getDbStats();
  }

  public override onRegistered(_mainWindow: BrowserWindow): void {
    Database.getDb();
  }
}
```

**Step 4: Make the schema.sql file get bundled into dist**

The build copies `public/` and there's a webpack config for the main process. Since `schema.sql` is a sibling of `database.ts`, it will be located via `__dirname` only if webpack copies it. Add a `copy-webpack-plugin` rule OR — simpler — inline the SQL.

**Inline approach (preferred for simplicity):** Replace `schema.sql` reading in `database.ts` with:

```ts
const schemaSql = `
${/* paste contents of schema.sql here */ ''}
`;
```

Concretely, edit `database.ts`'s `getDb()` and replace the two lines:
```ts
const schemaPath = path.join(__dirname, 'schema.sql');
const schemaSql = fs.readFileSync(schemaPath, 'utf8');
```
with the literal SQL as a template string. Delete the `import path` and `import fs` (or keep `fs` — used elsewhere later).

Then delete `schema.sql` (no longer needed):
```bash
rm packages/app/src/nativeBridge/modules/dbModule/schema.sql
```

**Step 5: Regenerate preload**

```bash
cd packages/app && npm run gen:app:preload
```
Expected: no errors; `windowApi.d.ts` now lists `insertMatch`, `getMatchesSince`, etc.

**Step 6: Type-check the app package**

```bash
cd packages/app && npx tsc --noEmit -p .
```
Expected: no errors. Fix any reported.

**Step 7: Smoke test via dev mode**

```bash
npm run dev:app
```
In the renderer dev tools console (Electron app window):

```js
await window.wowarenalogs.db.getDbStats()
// expected: { totalMatches: 0, totalRawBytes: 0, oldest: null, newest: null }
```

Verify the DB file was created:
```bash
ls -lh "$(node -e 'console.log(require("os").homedir())')/AppData/Roaming/WoW Arena Logs/matches.db"  # on Windows: %APPDATA%/WoW Arena Logs/matches.db
```

**Step 8: Commit**

```bash
git add packages/app/src/nativeBridge/modules/dbModule/
git add packages/app/src/preloadApi.ts packages/app/src/windowApi.d.ts
git commit -m "feat(app): implement dbModule with sqlite schema, insert, query, stats"
```

---

## Wire the live capture path

### Task 5: Have `LocalCombatsContext` write each new combat to SQLite

**Files:**
- Modify: `packages/web/hooks/LocalCombatsContext/index.tsx`

**Step 1: Add a helper at the top of the file (above the `IProps` interface)**

```ts
import { deriveMatchSummary } from '@wowarenalogs/parser';

async function persistCombatLocally(
  combat: IArenaMatch | IShuffleRound | IShuffleMatch | IBattlegroundCombat,
  rawLines: string[],
  sourceFile: string | null,
) {
  if (!window.wowarenalogs.db?.insertMatch) return;
  try {
    const summary = deriveMatchSummary(combat, sourceFile);
    await window.wowarenalogs.db.insertMatch(summary, rawLines.join('\n'));
  } catch (e) {
    console.error('local persist failed', e);
  }
}
```

You'll need the missing imports — extend the existing `@wowarenalogs/parser` import on line 13:

```ts
import {
  AtomicArenaCombat,
  buildQueryHelpers,
  CombatResult,
  CombatUnitSpec,
  CombatUnitType,
  deriveMatchSummary,
  getBurstDps,
  getEffectiveCombatDuration,
  getEffectiveDps,
  getEffectiveHps,
  IActivityStarted,
  IArenaMatch,
  IBattlegroundCombat,
  IShuffleMatch,
  IShuffleRound,
} from '@wowarenalogs/parser';
```

**Step 2: Hook the persist call into each combat callback**

In the `handleNewCombat` callback (around line 218), after `setCombats(...)` (line ~256), add:
```ts
persistCombatLocally(combat, combat.rawLines, null);
```

In `handleSoloShuffleRoundEnded` (around line 260), add the same call inside the `if (wowVersion === combat.wowVersion)` block after `setCombats`.

In `handleSoloShuffleEnded` (around line 268), add the call after the existing `if (wowVersion === combat.wowVersion)` block opens. Note: this fires for the parent shuffle match — also persist each round if not already persisted (rounds fire separately).

**Step 3: Type-check renderer**

```bash
cd packages/web && npx tsc --noEmit -p .
```
Expected: no errors.

**Step 4: Smoke test**

```bash
npm run dev:app
```
Have the user replay a combat log via `npm run start:simlog` in another terminal, OR queue a real arena. After it ends, in dev tools:

```js
await window.wowarenalogs.db.getDbStats()
// totalMatches should now be > 0
```

**Step 5: Commit**

```bash
git add packages/web/hooks/LocalCombatsContext/index.tsx
git commit -m "feat(web): persist new combats to local sqlite via dbModule"
```

---

## Read path

### Task 6: Add `useMatchesFromDb` and rewire the History page

**Files:**
- Create: `packages/shared/src/hooks/useMatchesFromDb.ts`
- Modify: `packages/web/app/(main)/history/page.tsx`
- Modify: `packages/shared/src/index.ts` (export the hook)

**Step 1: Define the row type and hook**

Create `packages/shared/src/hooks/useMatchesFromDb.ts`:

```ts
import { useQuery } from 'react-query';

export interface MatchSummaryDbRow {
  id: string;
  data_type: string;
  shuffle_match_id: string | null;
  sequence_number: number | null;
  start_time: number;
  end_time: number;
  duration_seconds: number;
  bracket: string;
  zone_id: string | null;
  wow_version: string;
  timezone: string;
  result: number | null;
  winning_team_id: string | null;
  player_team_id: string | null;
  player_id: string | null;
  player_spec: string | null;
  player_class: string | null;
  team0_specs: string | null;
  team1_specs: string | null;
  team0_mmr: number | null;
  team1_mmr: number | null;
  player_damage: number;
  player_healing: number;
  player_deaths: number;
  source_file: string | null;
  ingested_at: number;
  schema_version: number;
}

export function useMatchesFromDb(filter?: { since?: Date; bracket?: string }) {
  const sinceMs = filter?.since?.getTime() ?? 0;
  return useQuery<MatchSummaryDbRow[]>(
    ['db-matches', sinceMs, filter?.bracket],
    async () => {
      const fn = window.wowarenalogs?.db?.getMatchesSince;
      if (!fn) return [];
      return (await fn(sinceMs, filter?.bracket)) as MatchSummaryDbRow[];
    },
    { staleTime: 30_000 },
  );
}
```

**Step 2: Re-export**

Add to `packages/shared/src/index.ts`:

```ts
export * from './hooks/useMatchesFromDb';
```

**Step 3: Rewire History page**

Replace `packages/web/app/(main)/history/page.tsx` with:

```tsx
'use client';

import { CombatStubList, LoadingScreen, useMatchesFromDb } from '@wowarenalogs/shared';
import { LocalRemoteHybridCombat } from '@wowarenalogs/shared/src/components/CombatStubList/rows';
import { useMemo } from 'react';
import { TbLoader } from 'react-icons/tb';

export default function HistoryPage() {
  const matchesQuery = useMatchesFromDb();

  const hybridCombats = useMemo<LocalRemoteHybridCombat[]>(() => {
    const rows = matchesQuery.data ?? [];
    return rows
      .filter((r) => r.data_type === 'ArenaMatch' || r.data_type === 'ShuffleRound')
      .map((r) => ({
        isLocal: true,
        isShuffle: r.data_type === 'ShuffleRound',
        match: {
          __typename: r.data_type === 'ShuffleRound' ? 'ShuffleRoundStub' : 'ArenaMatchDataStub',
          id: r.id,
          startTime: r.start_time,
          endTime: r.end_time,
          durationInSeconds: r.duration_seconds,
          bracket: r.bracket,
          zoneId: r.zone_id ?? '',
          result: r.result ?? 0,
          playerTeamRating: r.team0_mmr ?? r.team1_mmr ?? 0,
          // additional stub fields as required by CombatStubList rows
        } as never,
      }));
  }, [matchesQuery.data]);

  if (matchesQuery.isLoading) return <LoadingScreen />;

  return (
    <div className="transition-all px-2 overflow-y-auto">
      <div className="animate-fadein mt-2">
        <CombatStubList viewerIsOwner={true} combats={hybridCombats} source="history" />
      </div>
      {matchesQuery.isFetching && (
        <div className="flex flex-row items-center justify-center animate-loader h-[300px]">
          <TbLoader color="gray" size={60} className="animate-spin-slow" />
        </div>
      )}
    </div>
  );
}
```

NOTE: The `as never` cast is a hack because the GraphQL stub types have many fields. **You will likely need to inspect `LocalRemoteHybridCombat` and `CombatStubList` row props to fill in fields the row component reads (e.g., player team specs, ratings).** Run the page and watch for runtime errors — fix shape mismatches as they surface.

**Step 4: Manual smoke test**

```bash
npm run dev:app
```
Navigate to `/history`. Expected: list shows entries persisted by Task 5. If shape mismatches blank rows or errors, iterate on the mapping.

**Step 5: Commit**

```bash
git add packages/shared/src/hooks/useMatchesFromDb.ts packages/shared/src/index.ts packages/web/app/\(main\)/history/page.tsx
git commit -m "feat(web): wire History page to local sqlite via useMatchesFromDb"
```

---

### Task 7: Add `useCombatFromDb` and rewire the match detail page

**Files:**
- Create: `packages/shared/src/hooks/useCombatFromDb.ts`
- Create: `packages/shared/src/components/common/CombatReportFromDb.tsx`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/web/app/(main)/match/page.tsx`

**Step 1: Hook implementation**

Create `packages/shared/src/hooks/useCombatFromDb.ts`:

```ts
import { WowVersion } from '@wowarenalogs/parser';
import { useQuery } from 'react-query';

import { Utils } from '../utils/utils';

export function useCombatFromDb(matchId: string, roundId?: string) {
  const queryParsedLog = useQuery(
    ['db-combat', matchId, roundId],
    async () => {
      const fn = window.wowarenalogs?.db?.getRawSlice;
      if (!fn) throw new Error('db bridge unavailable');
      const slice = await fn(matchId);
      if (!slice) return { matchId, combat: undefined };
      const results = Utils.parseFromStringArray(
        slice.rawText.split('\n'),
        slice.wowVersion as WowVersion,
        slice.timezone,
      );
      return {
        matchId,
        combat:
          results.arenaMatches.at(0) ||
          (roundId ? results.shuffleMatches[0]?.rounds[parseInt(roundId) - 1] : undefined),
      };
    },
    {
      cacheTime: 60 * 60 * 24 * 1000,
      staleTime: Infinity,
      enabled: matchId !== '',
    },
  );

  return {
    matchId,
    roundId,
    combat: queryParsedLog.data?.combat,
    loading: queryParsedLog.isLoading,
    error: queryParsedLog.error,
  };
}
```

**Step 2: Component wrapper**

Create `packages/shared/src/components/common/CombatReportFromDb.tsx`:

```tsx
import { useCombatFromDb } from '../../hooks/useCombatFromDb';
import { CombatReport } from '../CombatReport';
import { ErrorPage } from './ErrorPage';
import { LoadingPage } from './LoadingPage';

interface IProps {
  viewerIsOwner?: boolean;
  id: string;
  roundId?: string;
}

export function CombatReportFromDb({ id, roundId, viewerIsOwner }: IProps) {
  const combatQuery = useCombatFromDb(id, roundId);
  if (combatQuery.loading) return <LoadingPage />;
  if (combatQuery.combat) {
    return <CombatReport viewerIsOwner={viewerIsOwner} combat={combatQuery.combat} matchId={combatQuery.matchId} roundId={combatQuery.roundId} />;
  }
  return <ErrorPage message={JSON.stringify(combatQuery.error) || 'Match not found in local DB.'} />;
}
```

**Step 3: Re-export**

Add to `packages/shared/src/index.ts`:

```ts
export * from './hooks/useCombatFromDb';
export * from './components/common/CombatReportFromDb';
```

**Step 4: Rewire match page**

Inspect `packages/web/app/(main)/match/page.tsx` — replace `<CombatReportFromStorage>` usage with `<CombatReportFromDb>` (props match). Keep auth-gating logic if any, or strip it for the personal fork.

**Step 5: Smoke test**

```bash
npm run dev:app
```
Navigate to `/history`, click a match. Expected: full Combat Report renders. Compare a match to the same one in the prod app — confirm parity.

**Step 6: Commit**

```bash
git add packages/shared/src/hooks/useCombatFromDb.ts packages/shared/src/components/common/CombatReportFromDb.tsx packages/shared/src/index.ts packages/web/app/\(main\)/match/page.tsx
git commit -m "feat(web): wire match detail page to local sqlite via useCombatFromDb"
```

---

## Bootstrap

### Task 8: Add a bootstrap scanner that imports existing WoW logs on first run

**Files:**
- Create: `packages/app/src/nativeBridge/modules/dbModule/bootstrap.ts`
- Modify: `packages/app/src/nativeBridge/modules/dbModule/index.ts`

**Step 1: Implement scanner**

Create `packages/app/src/nativeBridge/modules/dbModule/bootstrap.ts`:

```ts
import { deriveMatchSummary, WoWCombatLogParser } from '@wowarenalogs/parser';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import * as Database from './database';

export async function bootstrapFromLogsFolder(folder: string, onProgress?: (current: number, total: number) => void): Promise<{ scanned: number; inserted: number }> {
  const files = fs
    .readdirSync(folder)
    .filter((f) => /^WoWCombatLog-.*\.txt$/i.test(f))
    .map((f) => path.join(folder, f));

  let scanned = 0;
  let inserted = 0;

  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length);
    const filePath = files[i];
    const sourceFile = path.basename(filePath);
    const parser = new WoWCombatLogParser(null);

    parser.on('arena_match_ended', (m) => {
      scanned++;
      const result = Database.insertMatch(deriveMatchSummary(m, sourceFile), m.rawLines.join('\n'));
      if (result.inserted) inserted++;
    });
    parser.on('solo_shuffle_round_ended', (r) => {
      scanned++;
      const result = Database.insertMatch(deriveMatchSummary(r, sourceFile), r.rawLines.join('\n'));
      if (result.inserted) inserted++;
    });
    parser.on('battleground_ended', (bg) => {
      scanned++;
      const result = Database.insertMatch(deriveMatchSummary(bg, sourceFile), bg.rawLines.join('\n'));
      if (result.inserted) inserted++;
    });

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) parser.parseLine(line);
    parser.flush();
    parser.removeAllListeners();
  }
  onProgress?.(files.length, files.length);
  return { scanned, inserted };
}

export function hasBootstrapped(): boolean {
  const db = Database.getDb();
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'bootstrapped_at'").get() as { value: string } | undefined;
  return !!row;
}

export function markBootstrapped(): void {
  const db = Database.getDb();
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('bootstrapped_at', ?)").run(String(Date.now()));
}
```

**Step 2: Expose IPC method + auto-trigger**

In `packages/app/src/nativeBridge/modules/dbModule/index.ts`, add:

```ts
import { bootstrapFromLogsFolder, hasBootstrapped, markBootstrapped } from './bootstrap';

// inside DbModule:
@moduleFunction()
public async runBootstrap(_mainWindow: BrowserWindow, folder: string): Promise<{ scanned: number; inserted: number }> {
  const result = await bootstrapFromLogsFolder(folder);
  markBootstrapped();
  return result;
}

@moduleFunction()
public async isBootstrapped(_mainWindow: BrowserWindow): Promise<boolean> {
  return hasBootstrapped();
}
```

**Step 3: Regenerate preload**

```bash
cd packages/app && npm run gen:app:preload
```

**Step 4: Add a manual trigger in the Settings page (or dev page)**

Open `packages/web/app/(main)/debug/page.tsx`. Below the existing `<button>` blocks, add:

```tsx
<button
  className="btn"
  onClick={async () => {
    const folders = Array.from(wowInstallations.values());
    const folder = folders[0] ? `${folders[0]}/Logs` : null;
    if (!folder) return alert('No WoW install configured');
    const isDone = await window.wowarenalogs.db?.isBootstrapped?.();
    if (isDone && !confirm('Already bootstrapped. Re-run?')) return;
    const r = await window.wowarenalogs.db?.runBootstrap?.(folder);
    alert(`Bootstrap done: scanned ${r?.scanned} inserted ${r?.inserted}`);
  }}
>
  Bootstrap from WoW Logs folder
</button>
```

**Step 5: Smoke test**

```bash
npm run dev:app
```
Visit `/debug`, click "Bootstrap from WoW Logs folder". Wait. Verify history populates after refresh.

**Step 6: Commit**

```bash
git add packages/app/src/nativeBridge/modules/dbModule/bootstrap.ts packages/app/src/nativeBridge/modules/dbModule/index.ts packages/app/src/preloadApi.ts packages/app/src/windowApi.d.ts packages/web/app/\(main\)/debug/page.tsx
git commit -m "feat: add bootstrap scanner to import existing wow logs into sqlite"
```

---

### Task 9: End-to-end manual smoke test

This is the Phase 1 acceptance gate. No code, just verification.

1. `git stash` any uncommitted work.
2. Delete the existing DB: `rm "$APPDATA/WoW Arena Logs/matches.db"` (Windows path).
3. `npm run dev:app`.
4. Navigate to `/debug`, click "Bootstrap from WoW Logs folder".
5. Wait for the alert. Expected `inserted` count: matches the ~72 number from the offline scan we ran earlier (give or take, depending on log retention).
6. Navigate to `/history`. Verify matches appear with right brackets, dates, results, MMRs.
7. Click a 3v3 match. Verify the Combat Report renders fully — units, timeline, damage panel, etc.
8. Click a solo shuffle round. Verify same.
9. Compare side-by-side with the prod downloaded app for the same match — should be visually identical (modulo UI chrome that's auth-gated in prod).
10. Quit dev mode. Re-run. Verify `/history` still shows the matches without re-bootstrapping.
11. Queue and finish a real arena (or replay one with `npm run start:simlog`). Verify it shows up in `/history` after the match ends.

If all 11 pass: Phase 1 is done. Tag the commit:

```bash
git tag phase1-local-sqlite-parity
```

---

## Troubleshooting

**`better-sqlite3` rebuild fails on Windows.**
- Ensure `node-gyp` prerequisites: a recent Visual Studio Build Tools install with C++ workload, plus Python 3.
- `npm run prepare` invokes `electron-builder install-app-deps`, which rebuilds against Electron's headers. If it fails, try:
  ```bash
  cd packages/app && npx electron-rebuild -f -w better-sqlite3
  ```

**`window.wowarenalogs.db` is undefined in renderer.**
- You forgot to run `npm run gen:app:preload` after adding the module.
- The Electron app caches the preload bundle — quit and restart `npm run dev:app`.

**History page shows blank rows.**
- The `LocalRemoteHybridCombat` shape didn't fully match what `CombatStubList` reads. Check the row component (`packages/shared/src/components/CombatStubList/rows.tsx`) for the fields it accesses and fill them in `useMemo` mapper.

**Combat Report shows "match not found".**
- The match id in the URL doesn't match what's in `match_summary`. Check the routing — prod may use slightly different ids for shuffle rounds (sequence-number suffix) than what we store.

---

## Phase 2 hooks (not in this plan)

Once Phase 1 is locked in, the analytics dashboard sits on top:

- New `/dashboard` page with charts: win rate over time, win rate vs comp, DPS/HPS distributions.
- Possible Phase 2 schema additions: `match_players` table for normalized per-player stats, `match_metrics` table for derived metrics (CC duration, kill target, first blood).
- Both additive — no migrations break Phase 1 data.
