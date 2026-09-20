import type { CredentialRecord } from '../config/schema.js';
import { BrainError } from '../contracts/errors.js';
import type { BrainDeps, RecoveryReport } from '../core/mutation.js';
import type { Principal } from '../core/types.js';
import { authenticate } from '../security/authenticate.js';

export type { RecoveryOperationReport, RecoveryOutcome, RecoveryReport } from '../core/mutation.js';

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

export function authenticateOwner(
  authorization: string | undefined,
  credentials: CredentialRecord[]
): Principal {
  const principal = authenticate(authorization, credentials);
  if (principal.role !== 'owner') {
    throw new BrainError({
      code: 'FORBIDDEN',
      message: 'recover-state requires an owner credential'
    });
  }
  return principal;
}

export function summariseRecovery(report: RecoveryReport): string {
  return (
    `recovery: inspected ${report.inspected}; finalized ${report.finalized}; ` +
    `conflicted ${report.conflicted}; failed ${report.failed}; released ${report.released}; ` +
    `pending ${report.pending}; blocking ${report.blocking_operations.length}`
  );
}
