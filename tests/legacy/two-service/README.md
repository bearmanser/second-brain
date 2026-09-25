# Retired two-service Docker suites

These suites exercised the pre-V2 deployment: one `brain` gateway plus a separate
Basic Memory `memory` service, and a multi-principal role model
(`worker`/`reviewer`/`owner` with per-scope grants).

Task 18 removed both of those from the production deployment. The suites are
retained here, outside `tests/e2e/`, only as historical reference for the wire
shapes and operator scripts they used. They are excluded from `vitest` by
`vitest.config.ts`, so neither `npm run test:e2e` nor CI runs them.

The current deployment is covered by:

- `tests/e2e/single-container.test.ts` — resolved Compose assertions plus a live
  single-container Docker run (model disabled, lexical fallback, capture, recall).
- `tests/e2e/offline-local-brain.test.ts` — no-fetch startup assertions and the
  offline artifact verification path.
- `tests/e2e/recovery.test.ts` — recovery, backup-manifest, and operator-script
  guards.
