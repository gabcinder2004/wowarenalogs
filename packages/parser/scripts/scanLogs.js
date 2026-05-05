/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { WoWCombatLogParser } = require('../dist/index.js');

const RESULT_NAMES = { 0: 'Unknown', 1: 'Draw', 2: 'Lose', 3: 'Win' };

const teamSpecs = (combat, teamId) =>
  Object.values(combat.units)
    .filter((u) => u.type === 1 && u.info && u.info.teamId === teamId)
    .map((u) => (u.spec && u.spec !== '0' ? u.spec : `class:${u.class}`))
    .sort();

const summariseArena = (m, source) => ({
  source,
  type: 'arena',
  id: m.id,
  startTime: m.startTime,
  endTime: m.endTime,
  durationSeconds: m.durationInSeconds,
  bracket: m.startInfo.bracket,
  zoneId: m.startInfo.zoneId,
  result: m.result,
  team0Specs: teamSpecs(m, '0'),
  team1Specs: teamSpecs(m, '1'),
  playerTeamId: m.playerTeamId,
  playerSpec: (Object.values(m.units).find((u) => u.id === m.playerId) || {}).spec,
  mmrAvg:
    m.endInfo && m.endInfo.team0MMR !== undefined && m.endInfo.team1MMR !== undefined
      ? (m.endInfo.team0MMR + m.endInfo.team1MMR) / 2
      : undefined,
});

const summariseShuffleRound = (r, source) => ({
  source,
  type: 'shuffleRound',
  id: r.id,
  startTime: r.startTime,
  endTime: r.endTime,
  durationSeconds: r.durationInSeconds,
  bracket: r.startInfo.bracket,
  zoneId: r.startInfo.zoneId,
  result: r.result,
  team0Specs: teamSpecs(r, '0'),
  team1Specs: teamSpecs(r, '1'),
  playerTeamId: r.playerTeamId,
  playerSpec: (Object.values(r.units).find((u) => u.id === r.playerId) || {}).spec,
  mmrAvg: undefined,
});

const summariseShuffleMatch = (m, source) => ({
  source,
  type: 'shuffleMatch',
  id: m.id,
  startTime: m.startTime,
  endTime: m.endTime,
  durationSeconds: m.durationInSeconds,
  bracket: m.startInfo.bracket,
  zoneId: m.startInfo.zoneId,
  result: m.result,
  team0Specs: [],
  team1Specs: [],
  playerTeamId: undefined,
  playerSpec: undefined,
  mmrAvg:
    m.endInfo && m.endInfo.team0MMR !== undefined && m.endInfo.team1MMR !== undefined
      ? (m.endInfo.team0MMR + m.endInfo.team1MMR) / 2
      : undefined,
});

const summariseBg = (bg, source) => ({
  source,
  type: 'battleground',
  id: bg.id,
  startTime: bg.startTime,
  endTime: bg.endTime,
  durationSeconds: (bg.endTime - bg.startTime) / 1000,
  bracket: 'battleground',
  zoneId: bg.zoneInEvent && bg.zoneInEvent.instanceId ? String(bg.zoneInEvent.instanceId) : '',
  result: undefined,
  team0Specs: [],
  team1Specs: [],
  playerTeamId: undefined,
  playerSpec: undefined,
  mmrAvg: undefined,
});

async function scanFile(filePath) {
  const summaries = [];
  const parser = new WoWCombatLogParser(null);
  const source = path.basename(filePath);

  parser.on('arena_match_ended', (m) => summaries.push(summariseArena(m, source)));
  parser.on('solo_shuffle_round_ended', (r) => summaries.push(summariseShuffleRound(r, source)));
  parser.on('solo_shuffle_ended', (m) => summaries.push(summariseShuffleMatch(m, source)));
  parser.on('battleground_ended', (bg) => summaries.push(summariseBg(bg, source)));
  parser.on('parser_error', (err) => console.warn(`  parser_error in ${source}: ${err.message}`));

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineCount = 0;
  for await (const line of rl) {
    parser.parseLine(line);
    lineCount++;
  }
  parser.flush();
  parser.removeAllListeners();

  console.log(`  ${source}: ${lineCount.toLocaleString()} lines -> ${summaries.length} match records`);
  return summaries;
}

const fmtDate = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
const fmtComp = (specs) => (specs.length ? specs.join('/') : '?');

async function main() {
  const folder =
    process.argv[2] ||
    process.env.WOW_LOGS_DIR ||
    'C:\\Program Files (x86)\\World of Warcraft\\_retail_\\Logs';

  console.log(`Scanning: ${folder}\n`);

  const allFiles = fs
    .readdirSync(folder)
    .filter((f) => /^WoWCombatLog-.*\.txt$/i.test(f))
    .map((f) => path.join(folder, f));

  if (allFiles.length === 0) {
    console.log('No WoWCombatLog-*.txt files found.');
    process.exit(0);
  }

  let totalBytes = 0;
  for (const f of allFiles) totalBytes += fs.statSync(f).size;

  console.log(`Found ${allFiles.length} log file(s), ${(totalBytes / 1024 / 1024).toFixed(1)} MB total\n`);

  const all = [];
  const startedAt = Date.now();
  for (const f of allFiles) {
    const before = Date.now();
    const recs = await scanFile(f);
    all.push(...recs);
    console.log(`    parsed in ${((Date.now() - before) / 1000).toFixed(1)}s`);
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(`\nDone in ${elapsed}s. Aggregating...\n`);

  all.sort((a, b) => a.startTime - b.startTime);

  const byType = all.reduce((acc, m) => {
    acc[m.type] = (acc[m.type] || 0) + 1;
    return acc;
  }, {});

  const byBracket = all.reduce((acc, m) => {
    acc[m.bracket] = (acc[m.bracket] || 0) + 1;
    return acc;
  }, {});

  const wins = all.filter((m) => m.result === 3).length;
  const losses = all.filter((m) => m.result === 2).length;
  const draws = all.filter((m) => m.result === 1).length;

  console.log('=== Summary ===');
  console.log(`Total match records: ${all.length}`);
  console.log(`By type:`, byType);
  console.log(`By bracket:`, byBracket);
  if (all.length > 0) {
    console.log(`Date range: ${fmtDate(all[0].startTime)}  ->  ${fmtDate(all[all.length - 1].startTime)}`);
    const days = (all[all.length - 1].startTime - all[0].startTime) / 86400000;
    console.log(`Span: ${days.toFixed(1)} days`);
  }
  console.log(`Win/Loss/Draw: ${wins} / ${losses} / ${draws}`);

  const playerSpecs = new Set(all.map((m) => m.playerSpec).filter(Boolean));
  if (playerSpecs.size) console.log(`Specs played:`, Array.from(playerSpecs));

  const sample = (label, rows) => {
    if (!rows.length) return;
    console.log(`\n${label}`);
    for (const m of rows) {
      const res = m.result !== undefined ? RESULT_NAMES[m.result] || String(m.result) : '?';
      const mmr = m.mmrAvg !== undefined ? ` mmr=${Math.round(m.mmrAvg)}` : '';
      console.log(
        `  ${fmtDate(m.startTime)} [${m.bracket}] ${res} ${Math.round(m.durationSeconds)}s ${fmtComp(
          m.team0Specs,
        )} vs ${fmtComp(m.team1Specs)}${mmr}`,
      );
    }
  };

  sample('First 5:', all.slice(0, 5));
  sample('Last 5:', all.slice(-5));

  const outPath = path.join(process.cwd(), 'scan-results.json');
  fs.writeFileSync(outPath, JSON.stringify(all, null, 2));
  console.log(`\nFull match summaries written to ${outPath} (${all.length} records).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
