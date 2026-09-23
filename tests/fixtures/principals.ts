import { SYSTEM_ACTOR, type AuthenticatedContext, type ScopeConfig } from '../../src/core/types.js';

const controller = new AbortController();

export const systemContext: AuthenticatedContext = {
  actor: SYSTEM_ACTOR,
  request_id: '00000000-0000-4000-8000-000000000011',
  signal: controller.signal
};

export const workerContext = systemContext;
export const reviewerContext = systemContext;
export const ownerContext = systemContext;

export const scopeFixtures: ScopeConfig[] = [
  {
    id: 'freellmapi',
    backend_project: 'freellmapi',
    relative_root: 'freellmapi',
    repository_aliases: ['freellmapi', 'free-llm-api']
  },
  {
    id: 'shared',
    backend_project: 'shared',
    relative_root: 'shared',
    repository_aliases: []
  },
  {
    id: 'profile',
    backend_project: 'profile',
    relative_root: 'profile',
    repository_aliases: []
  }
];
