import { BrainError } from '../contracts/errors.js';
import type { BrainDeps, RecoveryReport } from '../core/mutation.js';
import { verifyBearer } from '../security/authenticate.js';
import {
  classifyRecoveryInput,
  type RecoveryClassification,
  type RecoveryInputPresence
} from './local-rebuild.js';

export {
  classifyRecoveryInput,
  type RecoveryClassification,
  type RecoveryInputPresence
} from './local-rebuild.js';
export type { RecoveryOperationReport, RecoveryOutcome, RecoveryReport } from '../core/mutation.js';

export function requireDurableRecovery(classification: RecoveryClassification): void {
  if (!classification.history_recoverable || !classification.idempotency_recoverable) {
    throw new BrainError({
      code: 'RECOVERY_REQUIRED',
      message:
        'full recovery requires both durable history and the operation journal; ' +
        'a vault-only import cannot recover history or receipts'
    });
  }
}

export function summariseRecoveryInput(classification: RecoveryClassification): string {
  return (
    `recovery input: current ${classification.current_content_recoverable}, ` +
    `history ${classification.history_recoverable}, receipts ${classification.idempotency_recoverable}, ` +
    `index ${classification.index_rebuildable}`
  );
}

export function describeRecoveryInput(presence: RecoveryInputPresence): RecoveryClassification {
  return classifyRecoveryInput(presence);
}

export const RECOVERY_MODE = 'recover';

export async function recoverPending(deps: BrainDeps): Promise<RecoveryReport> {
  const report = await deps.mutations.recoverDetailed();
  deps.mutations.setRecoveryBlockers(report.blocking_operations);
  return report;
}

export function assertRecoveryMode(mode: string | undefined): void {
  if (mode !== RECOVERY_MODE) {
    throw new BrainError({
      code: 'INVALID_INPUT',
      message: `recover-state changes persistent state and requires an explicit --mode=${RECOVERY_MODE}`
    });
  }
}

export function requireRecoveryAuthorization(
  authorization: string | undefined,
  expectedDigest: string
): void {
  if (!verifyBearer(authorization, expectedDigest)) {
    throw new BrainError({
      code: 'UNAUTHENTICATED',
      message: 'recover-state requires the configured bearer token'
    });
  }
}

export function summariseRecovery(report: RecoveryReport): string {
  return (
    `recovery: inspected ${report.inspected}; finalized ${report.finalized}; ` +
    `conflicted ${report.conflicted}; failed ${report.failed}; released ${report.released}; ` +
    `pending ${report.pending}; blocking ${report.blocking_operations.length}`
  );
}
