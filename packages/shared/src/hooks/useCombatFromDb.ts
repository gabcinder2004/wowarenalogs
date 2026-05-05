import { IArenaMatch, IShuffleRound, WoWCombatLogParser, WowVersion } from '@wowarenalogs/parser';
import { useQuery } from 'react-query';

/**
 * Parse raw log text and return the first combat object found.
 *
 * WHY NOT Utils.parseFromStringArray:
 *   parseFromStringArray only listens to `arena_match_ended` and `solo_shuffle_ended`.
 *   A single shuffle-round's rawLines ends WITHOUT an ARENA_MATCH_END event, so the
 *   pipeline emits `solo_shuffle_round_ended` — which parseFromStringArray ignores,
 *   leaving both result arrays empty. We therefore wire the parser directly here so we
 *   can capture `solo_shuffle_round_ended` as well.
 *
 * Resolution order:
 *   1) Regular arena match (2v2 / 3v3) — fires `arena_match_ended`
 *   2) Solo shuffle round stored individually (Task 5 per-round storage) — fires `solo_shuffle_round_ended`
 *   3) Full shuffle match round addressed by roundId — fires `solo_shuffle_ended` (future-proofing)
 */
function parseRawSlice(
  rawText: string,
  wowVersion: WowVersion,
  timezone: string | undefined,
  roundId: string | undefined,
): IArenaMatch | IShuffleRound | undefined {
  const logParser = new WoWCombatLogParser(wowVersion, timezone);

  let arenaMatch: IArenaMatch | undefined;
  let shuffleRound: IShuffleRound | undefined;
  let shuffleRoundByIndex: IShuffleRound | undefined;

  logParser.on('arena_match_ended', (data: IArenaMatch) => {
    if (!arenaMatch) arenaMatch = data;
  });

  logParser.on('solo_shuffle_round_ended', (data: IShuffleRound) => {
    // The first round emitted is the one stored in this slice
    if (!shuffleRound) shuffleRound = data;
  });

  logParser.on('solo_shuffle_ended', (data) => {
    // Full-shuffle fallback: if caller provided a roundId, pick that round
    if (roundId !== undefined && !shuffleRoundByIndex) {
      const idx = parseInt(roundId, 10) - 1;
      shuffleRoundByIndex = data.rounds[idx];
    }
  });

  for (const line of rawText.split('\n')) {
    logParser.parseLine(line);
  }
  logParser.flush();

  return arenaMatch ?? shuffleRound ?? shuffleRoundByIndex;
}

export function useCombatFromDb(matchId: string, roundId?: string) {
  const queryParsedLog = useQuery(
    ['db-combat', matchId, roundId],
    async () => {
      const fn = window.wowarenalogs?.db?.getRawSlice;
      if (!fn) throw new Error('db bridge unavailable');

      const slice = await fn(matchId);
      if (!slice) return { matchId, combat: undefined };

      const combat = parseRawSlice(slice.rawText, slice.wowVersion, slice.timezone, roundId);
      return { matchId, combat };
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
