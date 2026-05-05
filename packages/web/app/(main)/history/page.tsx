'use client';

import { CombatStubList, LoadingScreen, rowToArenaMatch, rowToShuffleRound, useMatchesFromDb } from '@wowarenalogs/shared';
import { LocalRemoteHybridCombat } from '@wowarenalogs/shared/src/components/CombatStubList/rows';
import { useMemo } from 'react';
import { TbLoader } from 'react-icons/tb';

export default function HistoryPage() {
  const matchesQuery = useMatchesFromDb();

  const hybridCombats = useMemo<LocalRemoteHybridCombat[]>(() => {
    const rows = matchesQuery.data ?? [];
    return rows
      .filter((r) => r.dataType === 'ArenaMatch' || r.dataType === 'ShuffleRound')
      .map((r): LocalRemoteHybridCombat => {
        if (r.dataType === 'ShuffleRound') {
          return {
            isLocal: true,
            isShuffle: true,
            match: rowToShuffleRound(r),
          };
        }
        return {
          isLocal: true,
          isShuffle: false,
          match: rowToArenaMatch(r),
        };
      });
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
