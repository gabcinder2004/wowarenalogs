import {
  AtomicArenaCombat,
  IArenaMatch,
  IBattlegroundCombat,
  IShuffleMatch,
  IShuffleRound,
} from './CombatData';
import { CombatUnitClass, CombatUnitType } from './types';

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
    playerClass: player ? CombatUnitClass[player.class] : null,
    team0Specs: teamSpecs(m, '0'),
    team1Specs: teamSpecs(m, '1'),
    team0Mmr: m.endInfo?.team0MMR ?? null,
    team1Mmr: m.endInfo?.team1MMR ?? null,
    playerDamage: player?.damageOut?.reduce((a, e) => a + (e.effectiveAmount ?? 0), 0) ?? 0,
    playerHealing: player?.healOut?.reduce((a, e) => a + (e.effectiveAmount ?? 0), 0) ?? 0,
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
