import type { Principal, RequestContext, ScopeConfig } from '../../src/core/types.js';

export const workerPrincipal: Principal = {
  id: '00000000-0000-4000-8000-000000000001',
  role: 'worker',
  read_scopes: ['freellmapi', 'shared'],
  write_scopes: ['freellmapi'],
  review_scopes: []
};

export const reviewerPrincipal: Principal = {
  id: '00000000-0000-4000-8000-000000000002',
  role: 'reviewer',
  read_scopes: ['freellmapi', 'shared'],
  write_scopes: ['freellmapi'],
  review_scopes: ['freellmapi']
};

export const ownerPrincipal: Principal = {
  id: '00000000-0000-4000-8000-000000000003',
  role: 'owner',
  read_scopes: ['freellmapi', 'shared', 'profile'],
  write_scopes: ['freellmapi', 'shared', 'profile'],
  review_scopes: ['freellmapi', 'shared', 'profile']
};

export const workerAbortController = new AbortController();
export const reviewerAbortController = new AbortController();
export const ownerAbortController = new AbortController();

export const workerContext: RequestContext = {
  principal: workerPrincipal,
  request_id: '00000000-0000-4000-8000-000000000011',
  signal: workerAbortController.signal
};

export const reviewerContext: RequestContext = {
  principal: reviewerPrincipal,
  request_id: '00000000-0000-4000-8000-000000000012',
  signal: reviewerAbortController.signal
};

export const ownerContext: RequestContext = {
  principal: ownerPrincipal,
  request_id: '00000000-0000-4000-8000-000000000013',
  signal: ownerAbortController.signal
};

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
