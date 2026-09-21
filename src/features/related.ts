import { BrainError, isBrainError } from '../contracts/errors.js';
import type { BrainDeps } from '../core/mutation.js';
import type { RequestContext } from '../core/types.js';

function forbidden(message: string): BrainError {
  return new BrainError({ code: 'FORBIDDEN', message });
}

export async function authorizeRelatedIds(
  ctx: RequestContext,
  relatedIds: readonly string[],
  deps: BrainDeps
): Promise<void> {
  const targets = [...new Set(relatedIds)];
  if (targets.length === 0) return;
  const scopes = deps.scopeRegistry.visibleTo(ctx.principal);
  for (const target of targets) {
    let visible = false;
    for (const scope of scopes) {
      try {
        await deps.catalogue.get(scope.id, target);
        visible = true;
        break;
      } catch (error) {
        if (!isBrainError(error)) throw error;
        if (error.code === 'NOT_FOUND') continue;
        if (error.code === 'CONFLICT') {
          visible = true;
          break;
        }
        throw error;
      }
    }
    if (!visible) throw forbidden(`related note ${target} is not an authorized reference`);
  }
}
