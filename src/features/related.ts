import { BrainError, isBrainError } from '../contracts/errors.js';
import type { BrainDeps } from '../core/mutation.js';

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

export async function validateRelatedIds(
  relatedIds: readonly string[],
  deps: BrainDeps
): Promise<void> {
  const targets = [...new Set(relatedIds)];
  if (targets.length === 0) return;
  const scopes = deps.scopeRegistry.all();
  for (const target of targets) {
    let found = false;
    for (const scope of scopes) {
      try {
        await deps.catalogue.get(scope.id, target);
        found = true;
        break;
      } catch (error) {
        if (!isBrainError(error)) throw error;
        if (error.code === 'NOT_FOUND') continue;
        if (error.code === 'CONFLICT') {
          found = true;
          break;
        }
        throw error;
      }
    }
    if (!found) throw invalidInput(`related note ${target} does not exist`);
  }
}
