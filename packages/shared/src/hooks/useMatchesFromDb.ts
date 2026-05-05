import {
  CombatResult,
  CombatUnitAffiliation,
  CombatUnitClass,
  CombatUnitReaction,
  CombatUnitSpec,
  CombatUnitType,
  IArenaCombat,
  IArenaMatch,
  IShuffleRound,
} from '@wowarenalogs/parser';
import { useQuery } from 'react-query';

// ---------------------------------------------------------------------------
// Local row type – mirrors the camelCase shape returned by the IPC bridge.
// Defined here so we don't import from packages/app.
// ---------------------------------------------------------------------------
export interface MatchSummaryDbRow {
  id: string;
  dataType: 'ArenaMatch' | 'ShuffleRound' | 'ShuffleMatch' | 'BattlegroundCombat';
  shuffleMatchId: string | null;
  sequenceNumber: number | null;
  startTime: number;
  endTime: number;
  durationSeconds: number;
  bracket: string;
  zoneId: string | null;
  wowVersion: 'retail' | 'classic';
  timezone: string;
  result: number | null;
  winningTeamId: string | null;
  playerTeamId: string | null;
  playerId: string | null;
  playerSpec: string | null;
  playerClass: string | null;
  team0Specs: string | null;
  team1Specs: string | null;
  team0Mmr: number | null;
  team1Mmr: number | null;
  playerDamage: number;
  playerHealing: number;
  playerDeaths: number;
  sourceFile: string | null;
  ingestedAt: number;
  schemaVersion: number;
}

// ---------------------------------------------------------------------------
// Spec → class lookup (mirrors the switch in CombatData.ts)
// ---------------------------------------------------------------------------
function specToClass(specId: string): CombatUnitClass {
  switch (specId as CombatUnitSpec) {
    case CombatUnitSpec.DeathKnight_Blood:
    case CombatUnitSpec.DeathKnight_Frost:
    case CombatUnitSpec.DeathKnight_Unholy:
      return CombatUnitClass.DeathKnight;
    case CombatUnitSpec.DemonHunter_Havoc:
    case CombatUnitSpec.DemonHunter_Vengeance:
    case CombatUnitSpec.DemonHunter_Devourer:
      return CombatUnitClass.DemonHunter;
    case CombatUnitSpec.Druid_Balance:
    case CombatUnitSpec.Druid_Feral:
    case CombatUnitSpec.Druid_Guardian:
    case CombatUnitSpec.Druid_Restoration:
      return CombatUnitClass.Druid;
    case CombatUnitSpec.Hunter_BeastMastery:
    case CombatUnitSpec.Hunter_Marksmanship:
    case CombatUnitSpec.Hunter_Survival:
      return CombatUnitClass.Hunter;
    case CombatUnitSpec.Mage_Arcane:
    case CombatUnitSpec.Mage_Fire:
    case CombatUnitSpec.Mage_Frost:
      return CombatUnitClass.Mage;
    case CombatUnitSpec.Monk_BrewMaster:
    case CombatUnitSpec.Monk_Windwalker:
    case CombatUnitSpec.Monk_Mistweaver:
      return CombatUnitClass.Monk;
    case CombatUnitSpec.Paladin_Holy:
    case CombatUnitSpec.Paladin_Protection:
    case CombatUnitSpec.Paladin_Retribution:
      return CombatUnitClass.Paladin;
    case CombatUnitSpec.Priest_Discipline:
    case CombatUnitSpec.Priest_Holy:
    case CombatUnitSpec.Priest_Shadow:
      return CombatUnitClass.Priest;
    case CombatUnitSpec.Rogue_Assassination:
    case CombatUnitSpec.Rogue_Outlaw:
    case CombatUnitSpec.Rogue_Subtlety:
      return CombatUnitClass.Rogue;
    case CombatUnitSpec.Shaman_Elemental:
    case CombatUnitSpec.Shaman_Enhancement:
    case CombatUnitSpec.Shaman_Restoration:
      return CombatUnitClass.Shaman;
    case CombatUnitSpec.Warlock_Affliction:
    case CombatUnitSpec.Warlock_Demonology:
    case CombatUnitSpec.Warlock_Destruction:
      return CombatUnitClass.Warlock;
    case CombatUnitSpec.Warrior_Arms:
    case CombatUnitSpec.Warrior_Fury:
    case CombatUnitSpec.Warrior_Protection:
      return CombatUnitClass.Warrior;
    case CombatUnitSpec.Evoker_Devastation:
    case CombatUnitSpec.Evoker_Preservation:
    case CombatUnitSpec.Evoker_Augmentation:
      return CombatUnitClass.Evoker;
    default:
      return CombatUnitClass.None;
  }
}

// Build a minimal ICombatUnit-compatible object for a single player slot.
function makeUnitStub(specId: string, teamId: string, unitIndex: number) {
  const spec = specId as CombatUnitSpec;
  const unitClass = specToClass(specId);
  const id = `${teamId}-${unitIndex}`;
  return {
    id,
    name: '',
    ownerId: '',
    isWellFormed: true,
    reaction: teamId === '0' ? CombatUnitReaction.Friendly : CombatUnitReaction.Hostile,
    affiliation: CombatUnitAffiliation.None,
    type: CombatUnitType.Player,
    class: unitClass,
    spec,
    info: {
      teamId,
      strength: 0,
      agility: 0,
      stamina: 0,
      intelligence: 0,
      dodge: 0,
      parry: 0,
      block: 0,
      critMelee: 0,
      critRanged: 0,
      critSpell: 0,
      speed: 0,
      lifesteal: 0,
      hasteMelee: 0,
      hasteRanged: 0,
      hasteSpell: 0,
      avoidance: 0,
      mastery: 0,
      versatilityDamgeDone: 0,
      versatilityHealingDone: 0,
      versatilityDamageTaken: 0,
      armor: 0,
      specId,
      talents: [],
      pvpTalents: [],
      equipment: [],
      interestingAurasJSON: '',
      item28: 0,
      item29: 0,
      item9: 0,
      personalRating: 0,
      highestPvpTier: 0,
    },
    damageIn: [],
    damageOut: [],
    healIn: [],
    healOut: [],
    absorbsIn: [],
    absorbsOut: [],
    absorbsDamaged: [],
    supportDamageIn: [],
    supportDamageOut: [],
    supportHealIn: [],
    supportHealOut: [],
    actionIn: [],
    actionOut: [],
    auraEvents: [],
    spellCastEvents: [],
    deathRecords: [],
    consciousDeathRecords: [],
    advancedActions: [],
  };
}

// Reconstruct a units dict from the stored team0Specs / team1Specs strings.
function buildUnitsFromSpecs(
  team0Specs: string | null,
  team1Specs: string | null,
): Record<string, ReturnType<typeof makeUnitStub>> {
  const units: Record<string, ReturnType<typeof makeUnitStub>> = {};
  const addTeam = (specsStr: string | null, teamId: string) => {
    if (!specsStr) return;
    specsStr
      .split('/')
      .filter(Boolean)
      .forEach((specId, i) => {
        // specs stored as "class:N" for classic logs without spec data
        const cleanSpec = specId.startsWith('class:') ? CombatUnitSpec.None : specId;
        const stub = makeUnitStub(cleanSpec, teamId, i);
        units[stub.id] = stub;
      });
  };
  addTeam(team0Specs, '0');
  addTeam(team1Specs, '1');
  return units;
}

// Build common IArenaCombat-compatible fields from a DB row.
function buildArenaCombatBase(r: MatchSummaryDbRow): Omit<IArenaCombat, 'dataType' | 'endInfo'> {
  const units = buildUnitsFromSpecs(r.team0Specs, r.team1Specs);
  const playerTeamId = r.playerTeamId ?? '0';
  const mmr = playerTeamId === '0' ? r.team0Mmr : r.team1Mmr;
  return {
    id: r.id,
    wowVersion: r.wowVersion,
    timezone: r.timezone,
    startInfo: {
      timestamp: r.startTime,
      zoneId: r.zoneId ?? '',
      item1: '',
      bracket: r.bracket,
      isRanked: true,
    },
    units,
    events: [],
    rawLines: [],
    linesNotParsedCount: 0,
    startTime: r.startTime,
    endTime: r.endTime,
    playerId: r.playerId ?? '',
    playerTeamId,
    result: (r.result ?? CombatResult.Unknown) as CombatResult,
    durationInSeconds: r.durationSeconds,
    winningTeamId: r.winningTeamId ?? '',
    hasAdvancedLogging: false,
    playerTeamRating: mmr ?? undefined,
  };
}

// Map a DB row to IArenaMatch.
function rowToArenaMatch(r: MatchSummaryDbRow): IArenaMatch {
  return {
    ...buildArenaCombatBase(r),
    dataType: 'ArenaMatch',
    endInfo: {
      timestamp: r.endTime,
      winningTeamId: r.winningTeamId ?? '',
      matchDurationInSeconds: r.durationSeconds,
      team0MMR: r.team0Mmr ?? 0,
      team1MMR: r.team1Mmr ?? 0,
    },
  };
}

// Map a DB row to IShuffleRound.
function rowToShuffleRound(r: MatchSummaryDbRow): IShuffleRound {
  return {
    ...buildArenaCombatBase(r),
    dataType: 'ShuffleRound',
    killedUnitId: '',
    scoreboard: [],
    sequenceNumber: r.sequenceNumber ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export function useMatchesFromDb(filter?: { since?: Date; bracket?: string }) {
  const sinceMs = filter?.since?.getTime() ?? 0;
  return useQuery<MatchSummaryDbRow[]>(
    ['db-matches', sinceMs, filter?.bracket],
    async () => {
      const fn = (window as unknown as { wowarenalogs?: { db?: { getMatchesSince?: unknown } } }).wowarenalogs?.db
        ?.getMatchesSince;
      if (typeof fn !== 'function') return [];
      return (await (fn as (ms: number, bracket?: string) => Promise<MatchSummaryDbRow[]>)(
        sinceMs,
        filter?.bracket,
      )) as MatchSummaryDbRow[];
    },
    { staleTime: 30_000 },
  );
}

// Exported helpers so the History page can use them without re-importing parser types.
export { rowToArenaMatch, rowToShuffleRound };
