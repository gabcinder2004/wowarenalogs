import { deriveMatchSummary, WoWCombatLogParser } from '@wowarenalogs/parser';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import * as Database from './database';

export async function bootstrapFromLogsFolder(
  folder: string,
): Promise<{ scanned: number; inserted: number; files: number }> {
  if (!fs.existsSync(folder)) {
    return { scanned: 0, inserted: 0, files: 0 };
  }

  const files = fs
    .readdirSync(folder)
    .filter((f) => /^WoWCombatLog-.*\.txt$/i.test(f))
    .map((f) => path.join(folder, f));

  let scanned = 0;
  let inserted = 0;

  for (let i = 0; i < files.length; i++) {
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
    parser.on('parser_error', (err) => {
      // eslint-disable-next-line no-console
      console.warn(`[bootstrap] parser_error in ${sourceFile}:`, err);
    });

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) parser.parseLine(line);
    parser.flush();
    parser.removeAllListeners();
  }
  return { scanned, inserted, files: files.length };
}

export function hasBootstrapped(): boolean {
  const db = Database.getDb();
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'bootstrapped_at'").get() as
    | { value: string }
    | undefined;
  return !!row;
}

export function markBootstrapped(): void {
  const db = Database.getDb();
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('bootstrapped_at', ?)").run(String(Date.now()));
}
