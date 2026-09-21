# Automatic Repository Project Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision and authorize a Second Brain project automatically from a caller-supplied canonical Git remote identity, without operator file edits or a gateway restart.

**Architecture:** Add an idempotent `brain_project_ensure` MCP mutation backed by repository normalization, project/grant records in `journal.db`, and a live scope registry shared by authorization, storage, catalogue, and backend services. Project creation remains behind the gateway and uses only Basic Memory's pinned `create_memory_project` contract; `shared` and `profile` remain static protected scopes.

**Tech Stack:** Node.js 24, TypeScript 7, Zod 4, better-sqlite3, MCP TypeScript SDK 1.30, Vitest 5, Docker Compose, pinned Basic Memory 0.23.2 / FastMCP 4.0.0b1.

**Spec:** `docs/superpowers/specs/2026-09-21-automatic-repository-project-provisioning-design.md`

## Global Constraints

- Keep the public surface MCP-only and keep Basic Memory's port private.
- Keep the gateway vault mount read-only; Basic Memory must create dynamic project directories through its private MCP tool.
- Require a canonical Git remote; never provision from a folder basename.
- Preserve existing static scopes, credentials, notes, authorization behavior, and immutable revision semantics.
- Never log raw remote URLs, embedded credentials, tokens, absolute host paths, note bodies, or search queries.
- Reserve `shared`, `profile`, every static scope ID, and every configured alias against dynamic claims.
- Dynamic access is bound to principal ID and survives token rotation.
- Every mutation remains idempotent, journaled, bounded, and recoverable.
- Do not add project deletion or automatic garbage collection.
- Distinguish executed Docker/client evidence from tests that were not run.

## Review Focus

- A remote containing a password or access token must fail without echoing the input; Task 2 adds exact redaction tests.
- Concurrent ensures for SSH and HTTPS spellings of one repository must create one project and stable receipts; Task 5 adds a concurrency test.
- A backend-created project whose returned path differs from the server-generated path must enter `recovery_required`, never be adopted; Tasks 1 and 5 test the mismatch.
- Rotating to a new token for the same principal ID must preserve dynamic grants, while another principal must not inherit them; Tasks 3 and 6 test both cases.
- Restart, backup verification, restore, and catalogue rebuild must preserve dynamic project mappings and grants; Task 8 exercises the full lifecycle.

---

### Task 1: Prove and implement the pinned backend project-creation contract

**Files:**
- Modify: `src/storage/backend-contract.ts`
- Modify: `src/storage/basic-memory.ts`
- Modify: `src/core/types.ts`
- Modify: `tests/fixtures/backend/tools-list.json` only if the sanitized observed fixture lacks required response detail
- Modify: `tests/contract/backend.test.ts`
- Modify: `scripts/probe-compatibility.mts`
- Modify: `docs/compatibility.md`

**Interfaces:**
- Produces: `BackendPort.ensureProject(project: string, projectPath: string): Promise<{ created: boolean }>`
- Produces: `CREATE_MEMORY_PROJECT_TOOL`, `CreateMemoryProjectArguments`, `argumentsForProjectCreate()`, and `decodeProjectCreateResponse()`.
- Consumes: the pinned backend's `create_memory_project` and `list_memory_projects` tools.

- [ ] **Step 1: Write failing contract tests for the exact backend request**

Add cases asserting the gateway generates, rather than accepts, every sensitive backend argument:

```ts
expect(argumentsForProjectCreate('second-brain', '/app/data/Projects/second-brain')).toEqual({
  project_name: 'second-brain',
  project_path: '/app/data/Projects/second-brain',
  set_default: false,
  output_format: 'json'
});
```

Also assert malformed success payloads, a mismatched returned project name/path, and backend `isError` envelopes fail closed without leaking raw payloads.

- [ ] **Step 2: Run the focused contract test and confirm it fails**

Run: `npx vitest run tests/contract/backend.test.ts`

Expected: FAIL because project-create constants, argument mapping, decoder, and `ensureProject` do not exist.

- [ ] **Step 3: Add the narrow backend mapping**

Extend `BackendPort` and `BasicMemoryBackend` with:

```ts
ensureProject(project: string, projectPath: string): Promise<{ created: boolean }>;
```

Require `create_memory_project` in `REQUIRED_BACKEND_TOOLS`. `ensureProject` first lists projects, returns `{ created: false }` when present, otherwise calls only `create_memory_project`, then lists again and requires the exact generated name. Do not expose workspace, `set_default`, arbitrary path, or delete operations through public input.

- [ ] **Step 4: Run the contract suite green**

Run: `npx vitest run tests/contract/backend.test.ts`

Expected: PASS with exact request/response and malformed-envelope coverage.

- [ ] **Step 5: Extend the real compatibility probe**

In the disposable pinned backend probe, generate a unique project:

```ts
const project = `probe-${randomUUID()}`;
const projectPath = `/app/data/Projects/${project}`;
```

Call `create_memory_project`, assert `projectPath` is created, verify `list_memory_projects` returns `project`, and record the sanitized response shape in `docs/compatibility.md`.

- [ ] **Step 6: Run the compatibility gate**

Run in the Docker-capable WSL environment:

```bash
npm run build
BACKEND_MCP_URL=http://127.0.0.1:8000/mcp npx tsx scripts/probe-compatibility.mts
```

Expected: PASS proving the pinned backend creates the missing directory. If the directory is not created, stop implementation and revise the architecture; do not make the gateway vault mount writable.

- [ ] **Step 7: Commit the backend capability**

```bash
git add src/storage/backend-contract.ts src/storage/basic-memory.ts src/core/types.ts tests/contract/backend.test.ts scripts/probe-compatibility.mts docs/compatibility.md tests/fixtures/backend/tools-list.json
git commit -m "feat: support private backend project provisioning"
```

### Task 2: Normalize repository identities and publish project contracts

**Files:**
- Create: `src/projects/identity.ts`
- Create: `tests/unit/project-identity.test.ts`
- Modify: `src/contracts/content.ts`
- Modify: `src/core/types.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `tests/unit/contracts.test.ts`
- Modify: `tests/unit/tools.test.ts`

**Interfaces:**
- Produces: `normalizeRepositoryIdentity(remoteUrl: string): string`.
- Produces: `scopeCandidateForRepository(identity: string): string` and `scopeWithCollisionSuffix(candidate: string, identity: string): string`.
- Produces: `ProjectEnsureRequest` and `ProjectEnsureResult` in `src/core/types.ts`.
- Produces: `projectEnsureRequestSchema` and the published `brain_project_ensure` input/output JSON Schemas.

- [ ] **Step 1: Write failing identity table tests**

Use one parameterized table proving these three inputs normalize to `github.com/bearmanser/second-brain`:

```ts
[
  'https://github.com/bearmanser/second-brain.git',
  'ssh://git@github.com/bearmanser/second-brain.git',
  'git@github.com:bearmanser/second-brain.git'
]
```

Add rejection cases for empty paths, local paths, fragments, queries, encoded separators, control characters, `.`/`..`, `https://user:secret@host/repo.git`, and repositories whose derived scope is reserved.

- [ ] **Step 2: Run the focused unit tests red**

Run: `npx vitest run tests/unit/project-identity.test.ts tests/unit/contracts.test.ts tests/unit/tools.test.ts`

Expected: FAIL because identity functions and tool contracts are absent.

- [ ] **Step 3: Implement strict normalization and collision helpers**

Use the platform URL parser for URL forms and an anchored parser for scp-style SSH. Preserve repository path case in the identity, lowercase the host, strip one trailing `.git`, and derive a scope matching `^[a-z][a-z0-9-]{0,63}$`. Generate collision suffixes from the first 10 lowercase hex characters of SHA-256 over the normalized identity.

- [ ] **Step 4: Define request and response contracts**

Use these stable shapes:

```ts
interface ProjectEnsureRequest {
  idempotency_key: string;
  remote_url: string;
}

interface ProjectEnsureResult {
  operation_id: string;
  repository_identity: string;
  scope: string;
  created: boolean;
  permissions: { can_read: true; can_write: boolean; can_review: boolean };
  backend_ready: boolean;
  materialized: boolean;
  warnings: string[];
}
```

Mark `brain_project_ensure` non-read-only, non-destructive, idempotent, and closed-world.

- [ ] **Step 5: Run the identity and contract tests green**

Run: `npx vitest run tests/unit/project-identity.test.ts tests/unit/contracts.test.ts tests/unit/tools.test.ts`

Expected: PASS, including credential-redaction assertions that never match the submitted raw URL.

- [ ] **Step 6: Commit identity and public contracts**

```bash
git add src/projects/identity.ts src/contracts/content.ts src/core/types.ts src/mcp/tools.ts tests/unit/project-identity.test.ts tests/unit/contracts.test.ts tests/unit/tools.test.ts
git commit -m "feat: define repository project identity contracts"
```

### Task 3: Persist project mappings and role-matched principal grants

**Files:**
- Create: `src/storage/migrations/008-repository-projects.sql`
- Modify: `src/storage/journal.ts`
- Modify: `src/core/types.ts`
- Modify: `tests/unit/journal.test.ts`

**Interfaces:**
- Produces: `RepositoryProjectState = 'provisioning' | 'ready' | 'recovery_required'`.
- Produces: `RepositoryProjectRecord` and `DynamicProjectGrant`.
- Produces Journal methods `reserveProject`, `getProjectByIdentity`, `getProjectByScope`, `listReadyProjects`, `markProjectReady`, `markProjectRecoveryRequired`, `grantProject`, and `listProjectGrants`.

- [ ] **Step 1: Write failing migration and registry tests**

Cover unique identity/scope constraints, persisted lifecycle state, sanitized failure code, grant upsert, idempotent reservation replay, and reopening the same `journal.db`. Add this token-rotation invariant:

```ts
expect(journal.listProjectGrants(principalId)).toContainEqual({
  principal_id: principalId,
  scope: 'second-brain',
  can_read: true,
  can_write: true,
  can_review: true
});
```

The test must use two token digests mapping to the same `principalId`; grants must not depend on either digest.

- [ ] **Step 2: Run journal tests red**

Run: `npx vitest run tests/unit/journal.test.ts`

Expected: FAIL because migration 008 and project/grant APIs are absent.

- [ ] **Step 3: Add normalized SQLite tables**

Create `repository_projects` with unique `repository_identity` and `scope`, lifecycle constraints, generated backend/root values, creator and operation IDs, timestamps, and optional sanitized failure fields. Create `dynamic_project_grants` with primary key `(principal_id, scope)`, capability checks, and a foreign key to the project scope.

- [ ] **Step 4: Implement transaction-backed Journal methods**

Use immediate transactions for reservation, state transition, and grant upsert. Validate every row read from SQLite and throw `RECOVERY_REQUIRED` for unknown states or malformed stored capability values.

- [ ] **Step 5: Run journal tests green and verify migrations**

Run: `npx vitest run tests/unit/journal.test.ts tests/integration/bootstrap.test.ts`

Expected: PASS; a fresh database reaches migration 8 and an existing migration-7 database upgrades without changing prior rows.

- [ ] **Step 6: Commit persistence**

```bash
git add src/storage/migrations/008-repository-projects.sql src/storage/journal.ts src/core/types.ts tests/unit/journal.test.ts tests/integration/bootstrap.test.ts
git commit -m "feat: persist repository projects and grants"
```

### Task 4: Introduce one live scope and authorization registry

**Files:**
- Create: `src/projects/scope-registry.ts`
- Create: `tests/unit/scope-registry.test.ts`
- Modify: `src/security/authorise.ts`
- Modify: `src/storage/vault.ts`
- Modify: `src/notes/catalogue.ts`
- Modify: `src/storage/basic-memory.ts`
- Modify: `src/core/mutation.ts`
- Modify: `tests/unit/security.test.ts`
- Modify: `tests/unit/vault.test.ts`
- Modify: `tests/unit/catalogue.test.ts`

**Interfaces:**
- Produces: `ScopeRegistry` with `all()`, `get(idOrAlias)`, `visibleTo(principal)`, `permissions(principal, scope)`, and `registerReadyProject(project, grant)`.
- Changes: `resolveScopes` and `resolveLinkedScopes` consume `ScopeRegistry`, not a copied `ScopeConfig[]`.
- Changes: `VaultPort`, `CataloguePort`, and `BackendPort` gain `registerScope(scope: ScopeConfig): void` where runtime state is cached.

- [ ] **Step 1: Write failing registry and authorization tests**

Test static precedence, reserved-name rejection, role-matched dynamic grants, owner visibility of all ready dynamic projects, another reviewer's isolation, alias collisions, and no visibility of `provisioning` or `recovery_required` projects.

- [ ] **Step 2: Run focused tests red**

Run: `npx vitest run tests/unit/scope-registry.test.ts tests/unit/security.test.ts tests/unit/vault.test.ts tests/unit/catalogue.test.ts`

Expected: FAIL because live registration is not supported.

- [ ] **Step 3: Implement `ScopeRegistry`**

Build it from static configuration plus `Journal.listReadyProjects()` and stored grants. Keep static `shared` inclusion behavior. Calculate effective principal permissions from static arrays plus dynamic grants without mutating the authenticated `Principal` object.

- [ ] **Step 4: Make runtime collaborators register one new scope**

Add duplicate-safe `registerScope` implementations. They must accept an identical repeated registration and reject the same ID with a different backend project/root. `FileVault` must validate the now-existing directory through its read-only mount; it must never create it.

- [ ] **Step 5: Route all authorization through the registry**

Replace every `deps.config.scopes` authorization lookup in capture, recall, read, review, feedback, status, recovery, and retrieval-event recording with the registry. Preserve owner-only protected-note checks.

- [ ] **Step 6: Run focused and existing integration tests green**

Run: `npx vitest run tests/unit/scope-registry.test.ts tests/unit/security.test.ts tests/unit/vault.test.ts tests/unit/catalogue.test.ts tests/integration`

Expected: PASS with all previous static authorization cases unchanged.

- [ ] **Step 7: Commit live scope support**

```bash
git add src/projects/scope-registry.ts src/security/authorise.ts src/storage/vault.ts src/notes/catalogue.ts src/storage/basic-memory.ts src/core/mutation.ts tests/unit/scope-registry.test.ts tests/unit/security.test.ts tests/unit/vault.test.ts tests/unit/catalogue.test.ts tests/integration
git commit -m "feat: resolve authorization through a live scope registry"
```

### Task 5: Implement idempotent project provisioning and recovery

**Files:**
- Create: `src/features/project-ensure.ts`
- Create: `tests/integration/project-ensure.test.ts`
- Modify: `src/operations/recovery.ts`
- Modify: `src/core/mutation.ts`
- Modify: `src/core/limits.ts`
- Modify: `src/config/schema.ts`
- Modify: `config/brain.example.yaml`
- Modify: `src/storage/journal.ts`
- Modify: `tests/e2e/recovery.test.ts`

**Interfaces:**
- Produces: `ensureProject(ctx: RequestContext, request: ProjectEnsureRequest, deps: BrainDeps): Promise<ProjectEnsureResult>`.
- Produces: recovery handling for journal operations whose `tool` is `brain_project_ensure`.
- Consumes: identity helpers, `Journal` project methods, `BackendPort.ensureProject`, and `ScopeRegistry.registerReadyProject`.

- [ ] **Step 1: Write the failing happy-path and replay tests**

Assert a reviewer receives read/write/review, a worker receives read/write only, an owner receives all project capabilities, and repeating the same key and normalized remote returns the stored receipt without a second backend call.

- [ ] **Step 2: Add failure and concurrency tests before implementation**

Cover interruption after reservation, after backend creation, before grant, and before receipt; mismatched backend mapping; static/reserved collisions; same idempotency key with a different remote; and concurrent SSH/HTTPS ensure calls. The concurrent case must assert one backend creation and one ready registry row. Add a fake-clock table proving the eleventh ensure by one principal in sixty seconds and the fifty-first global ensure are rejected with `LIMIT_EXCEEDED`, and prove a maximum of 1,000 ready dynamic projects is enforced across restarts.

- [ ] **Step 3: Run the new integration test red**

Run: `npx vitest run tests/integration/project-ensure.test.ts`

Expected: FAIL because the feature service is absent.

- [ ] **Step 4: Implement the journaled provisioning state machine**

Reserve the operation using the normalized identity hash and a server-generated project plan. Serialize by repository identity/scope, invoke backend creation, verify the directory through `FileVault.registerScope`, add the role-matched grant, register all runtime collaborators, mark ready, and persist the typed result. Never accept a caller-provided scope, backend name, or path.

Add validated limit defaults to `brainLimitsSchema` and `config/brain.example.yaml`:

```yaml
project_provision_per_principal_per_minute: 10
project_provision_global_per_minute: 50
dynamic_projects_max: 1000
```

Track the sliding one-minute counters without sensitive input, and enforce the persisted total-project bound before reservation.

- [ ] **Step 5: Extend startup and owner recovery**

For pending project operations, compare the expected backend name/path with `list_memory_projects`, resume a missing creation, finalize an exact match, and mark conflicts `recovery_required`. Unrelated ready scopes remain readable; the affected project refuses mutations.

- [ ] **Step 6: Run provisioning and recovery suites green**

Run: `npx vitest run tests/integration/project-ensure.test.ts tests/e2e/recovery.test.ts`

Expected: PASS with deterministic recovery outcomes and no duplicate project creation.

- [ ] **Step 7: Commit provisioning logic**

```bash
git add src/features/project-ensure.ts src/operations/recovery.ts src/core/mutation.ts src/core/limits.ts src/config/schema.ts src/storage/journal.ts config/brain.example.yaml tests/integration/project-ensure.test.ts tests/e2e/recovery.test.ts
git commit -m "feat: provision repository projects idempotently"
```

### Task 6: Expose `brain_project_ensure` through MCP and runtime startup

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/instructions.ts`
- Modify: `src/runtime.ts`
- Modify: `src/features/status.ts`
- Modify: `tests/integration/mcp.test.ts`
- Modify: `tests/unit/instructions.test.ts`
- Modify: `tests/integration/http-security.test.ts`

**Interfaces:**
- Extends: `BrainServices` with `projectEnsure(ctx, request)`.
- Publishes: seven MCP tools, including `brain_project_ensure`.
- Loads: static and ready dynamic scopes before serving requests.

- [ ] **Step 1: Write failing real-client MCP tests**

Connect through the official MCP SDK, call `brain_project_ensure`, assert its annotations/schema/result, immediately capture and recall with the returned scope, reconnect, and repeat. Add a second principal and prove it cannot see or use the first principal's project until it ensures the same identity and receives its own role-matched grant.

- [ ] **Step 2: Write failing instruction and HTTP safety tests**

Assert the first 512 instruction characters tell the agent to obtain `git remote get-url origin` and call ensure. Verify malformed/remotes-with-secrets produce sanitized MCP errors and logs, and an unauthenticated ensure receives the normal bearer challenge.

- [ ] **Step 3: Run MCP-focused tests red**

Run: `npx vitest run tests/integration/mcp.test.ts tests/unit/instructions.test.ts tests/integration/http-security.test.ts`

Expected: FAIL with six-tool expectations and missing service wiring.

- [ ] **Step 4: Wire the seventh tool**

Register the new handler and output Zod schema through the same source-of-truth mechanism as existing tools. Track it with the mutation guard, include it in auditing, and keep output bounded in both `structured` and `text-json` modes.

- [ ] **Step 5: Load dynamic registry state during runtime construction**

Open `journal.db`, build `ScopeRegistry`, register every ready dynamic scope with backend/vault/catalogue before recovery, then expose services. Update `brain_status` to merge static and dynamic visibility and to report caller-visible provisioning failures without cross-principal disclosure.

- [ ] **Step 6: Run all MCP and integration suites green**

Run: `npm run test:integration && npm test -- tests/unit/instructions.test.ts tests/unit/tools.test.ts tests/unit/security.test.ts`

Expected: PASS and tool lists contain exactly seven tools.

- [ ] **Step 7: Commit MCP/runtime integration**

```bash
git add src/mcp/server.ts src/mcp/tools.ts src/mcp/instructions.ts src/runtime.ts src/features/status.ts tests/integration/mcp.test.ts tests/unit/instructions.test.ts tests/integration/http-security.test.ts
git commit -m "feat: expose automatic repository project provisioning"
```

### Task 7: Update setup, backup, operations, and user documentation

**Files:**
- Modify: `src/operations/bootstrap.ts`
- Modify: `scripts/setup.sh`
- Modify: `scripts/backup.sh`
- Modify: `scripts/restore.sh`
- Modify: `scripts/rebuild.sh`
- Modify: `docs/setup.md`
- Modify: `docs/operations.md`
- Modify: `docs/security.md`
- Modify: `docs/agent-protocol.md`
- Modify: `README.md`
- Modify: `tests/integration/bootstrap.test.ts`
- Modify: `tests/e2e/operations.test.ts`

**Interfaces:**
- Changes fresh setup to require only reserved static scopes `shared` and `profile`; existing configured project scopes remain supported.
- Documents the seven-tool Git-identity workflow and client-controlled automation limitation.

- [ ] **Step 1: Write failing bootstrap and operations tests**

Assert a clean setup can start without a named pilot project, existing `freellmapi` deployments remain valid, backup manifests include the migrated `journal.db`, restore preserves project/grant rows, and rebuild rehydrates ready dynamic scopes without creating or deleting projects.

- [ ] **Step 2: Run focused tests red**

Run: `npx vitest run tests/integration/bootstrap.test.ts tests/e2e/operations.test.ts`

Expected: FAIL where setup assumes `freellmapi` and operations do not validate dynamic registry state.

- [ ] **Step 3: Make setup and operations backward compatible**

Keep `BRAIN_SCOPE` supported for explicitly pre-provisioned deployments, but make a fresh default setup create only reserved scopes and credentials capable of receiving dynamic grants. Ensure backup/restore/rebuild validation treats project mappings and grants as essential operational state in `journal.db`.

- [ ] **Step 4: Rewrite the runbook around automatic provisioning**

Document that agents derive the Git remote, call ensure, and use the returned scope. Include repositories without an origin, canonicalization examples, collision behavior, role-matched access, owner recovery, rate limits, and the fact that clients may ignore MCP instructions.

- [ ] **Step 5: Run setup and operations tests green**

Run: `npx vitest run tests/integration/bootstrap.test.ts tests/e2e/operations.test.ts`

Expected: PASS for clean and upgrade paths.

- [ ] **Step 6: Commit deployment and documentation**

```bash
git add src/operations/bootstrap.ts scripts/setup.sh scripts/backup.sh scripts/restore.sh scripts/rebuild.sh docs/setup.md docs/operations.md docs/security.md docs/agent-protocol.md README.md tests/integration/bootstrap.test.ts tests/e2e/operations.test.ts
git commit -m "docs: make repository provisioning hands-off"
```

### Task 8: Complete Docker lifecycle, security, and release-gate validation

**Files:**
- Modify: `tests/support/harness.ts`
- Modify: `tests/e2e/docker.test.ts`
- Modify: `tests/e2e/security.test.ts`
- Modify: `tests/e2e/lifecycle.test.ts`
- Modify: `tests/eval/agent.mts`
- Modify: `tests/eval/instruction.mts`
- Modify: `docs/evaluation.md`
- Modify: `docs/requirement-coverage.md`
- Create: `docs/release-gate/2026-09-21/automatic-projects-verify.txt`
- Create: `docs/release-gate/2026-09-21/automatic-projects-e2e.txt`
- Create: `docs/release-gate/2026-09-21/automatic-projects-compatibility.txt`

**Interfaces:**
- Verifies the complete public-MCP-to-private-backend path against the pinned container image.
- Records client pilot results only when an external-model budget is explicitly approved.

- [ ] **Step 1: Extend the Docker harness for unknown repositories**

Add helpers that call ensure as worker, reviewer, and owner identities, inspect materialized files through the host fixture only, restart services, and query persisted project/grant rows without exposing tokens.

- [ ] **Step 2: Add full lifecycle and security cases**

Test real creation, immediate capture/recall, restart persistence, concurrent principals, reserved-name defense, secret-bearing remotes, path mismatch, backend unavailability, recovery, loopback-only publication, and absence of a public Basic Memory port.

- [ ] **Step 3: Run the complete non-model verification**

Run:

```bash
npm run verify
npm run test:integration
npm run test:e2e
npm run eval:retrieval
```

Expected: all commands exit 0. Save complete command/version/result transcripts in the three release-gate files; do not label skipped external-model work green.

- [ ] **Step 4: Run the instruction/agent pilot only with approved budget**

From two real temporary Git repositories with distinct remotes, verify whether the installed client obtains `origin`, calls ensure, uses the returned scope, recalls, and captures without operator configuration. If no budget is approved, record `NOT RUN` in `docs/evaluation.md`.

- [ ] **Step 5: Update coverage records and inspect the whole branch**

Map every acceptance criterion to source and executed evidence. Run:

```bash
git diff --check d1088e7..HEAD
git status --short
```

Expected: no whitespace errors and only intentional release-gate artifacts, if any, remain uncommitted.

- [ ] **Step 6: Commit final validation evidence**

```bash
git add tests/support/harness.ts tests/e2e/docker.test.ts tests/e2e/security.test.ts tests/e2e/lifecycle.test.ts tests/eval/agent.mts tests/eval/instruction.mts docs/evaluation.md docs/requirement-coverage.md docs/release-gate/2026-09-21/automatic-projects-verify.txt docs/release-gate/2026-09-21/automatic-projects-e2e.txt docs/release-gate/2026-09-21/automatic-projects-compatibility.txt
git commit -m "test: verify automatic repository provisioning"
```

### Task 9: Final branch verification and review

**Files:**
- Inspect: all files changed since `d1088e7`
- Modify only if verification or review finds a concrete defect.

**Interfaces:**
- Consumes the complete feature branch.
- Produces final evidence suitable for merge/release decisions.

- [ ] **Step 1: Run the full fresh verification gate**

Run:

```bash
npm run verify
npm run test:integration
npm run test:e2e
npm run eval:retrieval
git diff --check d1088e7..HEAD
git status --short
```

Expected: all executable checks exit 0, retrieval evaluation meets its recorded gate, diff check is clean, and the worktree is clean.

- [ ] **Step 2: Review acceptance criteria against evidence**

Check all eight criteria in the spec and record any client pilot as executed or `NOT RUN`. Confirm the gateway mount remains read-only in `compose.yaml`, only port 7331 is published, and no token or raw secret-bearing remote appears in tracked files.

- [ ] **Step 3: Perform the requested native whole-branch review**

Use `superpowers:requesting-code-review` after implementation. Address only concrete correctness, security, recovery, or contract findings, then rerun the affected test commands and the full verification gate.

- [ ] **Step 4: Commit review fixes if needed**

Inspect `git diff --name-only d1088e7..HEAD`, stage only files changed for concrete review findings with explicit paths, then run `git commit -m "fix: address automatic provisioning review findings"`.

If no findings require changes, do not create an empty commit.
