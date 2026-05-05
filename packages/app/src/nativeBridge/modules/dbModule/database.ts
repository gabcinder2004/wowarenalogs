import type { MatchSummaryRow } from '@wowarenalogs/parser';
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';

export interface MatchSummaryDbRow extends MatchSummaryRow {
  ingestedAt: number;
  schemaVersion: number;
}

const SELECT_MATCH_SUMMARY_COLUMNS = `
  id,
  data_type AS dataType,
  shuffle_match_id AS shuffleMatchId,
  sequence_number AS sequenceNumber,
  start_time AS startTime,
  end_time AS endTime,
  duration_seconds AS durationSeconds,
  bracket,
  zone_id AS zoneId,
  wow_version AS wowVersion,
  timezone,
  result,
  winning_team_id AS winningTeamId,
  player_team_id AS playerTeamId,
  player_id AS playerId,
  player_spec AS playerSpec,
  player_class AS playerClass,
  team0_specs AS team0Specs,
  team1_specs AS team1Specs,
  team0_mmr AS team0Mmr,
  team1_mmr AS team1Mmr,
  player_damage AS playerDamage,
  player_healing AS playerHealing,
  player_deaths AS playerDeaths,
  source_file AS sourceFile,
  ingested_at AS ingestedAt,
  schema_version AS schemaVersion
`;

const SCHEMA_SQL = `
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
`;

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;
  const dbPath = path.join(app.getPath('userData'), 'matches.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  dbInstance = db;
  return db;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function getDbStats(): {
  totalMatches: number;
  totalRawBytes: number;
  oldest: number | null;
  newest: number | null;
} {
  const db = getDb();
  const summary = db
    .prepare('SELECT COUNT(*) as c, MIN(start_time) as o, MAX(start_time) as n FROM match_summary')
    .get() as { c: number; o: number | null; n: number | null };
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

export function getMatchesSince(sinceMs: number, bracket?: string): MatchSummaryDbRow[] {
  const db = getDb();
  if (bracket) {
    return db
      .prepare(
        `SELECT ${SELECT_MATCH_SUMMARY_COLUMNS} FROM match_summary WHERE start_time >= ? AND bracket = ? ORDER BY start_time DESC`,
      )
      .all(sinceMs, bracket) as MatchSummaryDbRow[];
  }
  return db
    .prepare(`SELECT ${SELECT_MATCH_SUMMARY_COLUMNS} FROM match_summary WHERE start_time >= ? ORDER BY start_time DESC`)
    .all(sinceMs) as MatchSummaryDbRow[];
}

export function getMatchById(id: string): MatchSummaryDbRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT ${SELECT_MATCH_SUMMARY_COLUMNS} FROM match_summary WHERE id = ?`).get(id) as
    | MatchSummaryDbRow
    | undefined;
  return row ?? null;
}

export function getRawSlice(
  id: string,
): { rawText: string; wowVersion: MatchSummaryRow['wowVersion']; timezone: string } | null {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT r.raw_text as rawText, s.wow_version as wowVersion, s.timezone
      FROM match_raw r JOIN match_summary s ON s.id = r.id
      WHERE r.id = ?
    `,
    )
    .get(id) as { rawText: string; wowVersion: MatchSummaryRow['wowVersion']; timezone: string } | undefined;
  return row ?? null;
}
