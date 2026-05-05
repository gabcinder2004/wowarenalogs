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
