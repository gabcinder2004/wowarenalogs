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
  const defaultErrorMessage = 'Match not found in local DB.';
  const combatQuery = useCombatFromDb(id, roundId);

  if (combatQuery.loading) {
    return <LoadingPage />;
  }
  if (combatQuery.combat) {
    return (
      <CombatReport
        viewerIsOwner={viewerIsOwner}
        combat={combatQuery.combat}
        matchId={combatQuery.matchId}
        roundId={combatQuery.roundId}
      />
    );
  }
  let message: string;
  if (combatQuery.error instanceof Error) {
    message = combatQuery.error.message;
  } else if (combatQuery.error) {
    message = JSON.stringify(combatQuery.error);
  } else {
    message = defaultErrorMessage;
  }
  return <ErrorPage message={message} />;
}
