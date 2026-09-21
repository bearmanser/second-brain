# Automatic Repository Project Provisioning Design

**Date:** 2026-09-21
**Status:** Approved design, awaiting implementation planning

## 1. Purpose

Second Brain currently requires an operator to edit `config/brain.yaml`, seed a
Basic Memory project, create a vault directory, and update credential scopes
before an agent can use memory for a new repository. This is too much manual
administration for normal project work.

After this change, an agent working in a Git repository can submit the
repository's canonical remote identity to one idempotent MCP tool. The gateway
creates or resolves the corresponding Second Brain project and grants the caller
role-matched access. The user does not edit YAML, JSON credentials, Basic Memory
configuration, or vault directories for each project.

The feature preserves the existing security model:

- repository identity is explicit input, not guessed from a directory basename;
- `shared` and `profile` remain protected, statically configured scopes;
- one principal does not inherit another principal's dynamically provisioned
  projects;
- project creation does not grant owner privileges;
- the public surface remains MCP-only.

## 2. User experience

At the start of substantial work in a Git repository, the agent obtains the
repository's `origin` URL locally and calls:

```json
{
  "remote_url": "https://github.com/bearmanser/second-brain.git"
}
```

The new `brain_project_ensure` tool returns a stable scope:

```json
{
  "repository_identity": "github.com/bearmanser/second-brain",
  "scope": "second-brain",
  "created": true,
  "permissions": {
    "can_read": true,
    "can_write": true,
    "can_review": true
  }
}
```

The agent uses the returned scope for `brain_recall`, `brain_capture`,
`brain_read`, `brain_review`, and `brain_feedback`. Repeated ensure calls for the
same repository and principal return the same mapping and permissions without
creating additional projects or directories.

The MCP initialization instructions tell agents to derive the Git identity and
call `brain_project_ensure` before project-scoped memory operations. Instruction
delivery remains client-controlled: the server cannot observe a client's current
working directory and cannot guarantee that a host follows initialization text.

## 3. Alternatives considered

### 3.1 Explicit idempotent ensure tool — selected

An agent calls one provisioning tool before using project memory. The mutation
is visible in the MCP contract, can be authorized and audited, and has a clear
idempotency boundary.

### 3.2 Provision during recall or capture — rejected

This would make a read-only recall create persistent state and would let a typo
silently create a project. Tool annotations and user expectations would no
longer match behavior.

### 3.3 Codex-specific wrapper or hook — rejected

A local wrapper could inspect the working directory without an MCP call, but it
would couple the system to one client and contradict the portable MCP-only
architecture.

## 4. Repository identity

### 4.1 Input

`brain_project_ensure` accepts:

- `remote_url`: required, nonempty Git remote URL;
- `idempotency_key`: required UUID, using the same mutation semantics as other
  gateway writes.

The first release requires a remote. A local directory name is not a stable
identity and is not accepted as a fallback. Repositories without a remote return
`INVALID_INPUT` with guidance to configure `origin` first.

### 4.2 Normalization

The gateway normalizes common HTTPS and SSH spellings to one identity:

- `https://github.com/Owner/Repo.git`
- `ssh://git@github.com/Owner/Repo.git`
- `git@github.com:Owner/Repo.git`

The normalized identity has the form `host/path`, with:

- credentials, query, fragment, scheme, and default port removed;
- host lowercased and IDNA-normalized by the URL parser;
- leading and trailing slashes removed;
- one trailing `.git` suffix removed case-insensitively;
- empty segments, `.` and `..`, control characters, encoded separators, and
  ambiguous malformed forms rejected;
- path spelling otherwise preserved so the gateway does not impose a hosting
  provider's case rules on every Git server.

Normalization must never place the original URL, embedded credentials, or local
filesystem paths in logs or tool errors. Diagnostics may record the normalized
identity hash and chosen scope.

### 4.3 Scope derivation and collisions

The initial scope candidate is derived from the final repository path segment:

1. lowercase;
2. replace runs outside `[a-z0-9]` with `-`;
3. trim hyphens;
4. ensure the existing scope pattern and maximum length;
5. reject reserved names `shared` and `profile`.

If the candidate is already bound to another repository identity, append a
deterministic short SHA-256 suffix. Shortening preserves the suffix within the
scope length limit. The full normalized repository identity remains the unique
key; the readable scope is an assigned identifier, not identity proof.

## 5. Persistent model

Dynamic project state belongs in the gateway's existing `journal.db`, not in
generated YAML or the credential file.

### 5.1 Project registry

A migration adds a `repository_projects` table containing at least:

- normalized repository identity as a unique key;
- assigned scope as a unique key;
- Basic Memory project name;
- vault-relative root;
- lifecycle state: `provisioning`, `ready`, or `recovery_required`;
- creating principal ID;
- creation operation ID and timestamps;
- last failure stage and sanitized diagnostic code when recovery is required.

Static scopes from `brain.yaml` and dynamic scopes form one runtime scope
registry. Static IDs and aliases take precedence and cannot be shadowed by a
dynamic project.

### 5.2 Principal grants

A second table records dynamic grants by principal ID and scope. Grants are
derived from the authenticated principal's role when it first ensures the
project:

| Role | Read | Write | Review |
|---|---:|---:|---:|
| worker | yes | yes | no |
| reviewer | yes | yes | yes |
| owner | yes | yes | yes |

The grant stores capabilities, not a copied role string, so later authorization
uses the same explicit read/write/review checks as static scopes. An owner may
access every ready dynamic project and may repair provisioning, but a reviewer
or worker sees only projects granted to that principal.

Existing static arrays in `secrets/credentials.json` remain valid for static
scopes. Dynamic grants do not rewrite the credential file and survive token
rotation because rotated tokens can continue to map to the same principal ID.

## 6. Provisioning workflow

`brain_project_ensure` is a non-destructive, idempotent mutation. It uses the
existing operation journal and per-scope mutation locking rather than adding an
independent transaction mechanism.

For a new normalized identity:

1. authenticate the principal and validate the idempotency key and remote;
2. reserve the identity and deterministic scope in SQLite with state
   `provisioning`;
3. call the private Basic Memory `create_memory_project` tool with the generated
   project name and the exact `/app/data/Projects/<scope>` path; Basic Memory,
   which retains the only read/write vault mount, creates the project directory;
4. verify the project through `list_memory_projects` and verify the new directory
   through the gateway's read-only vault mount using the existing canonical-path
   and symlink safety checks;
6. record the role-matched dynamic grant;
7. mark the project `ready` and commit the operation receipt;
8. add the ready scope to the live backend, vault, catalogue, retrieval, and
   authorization registries without restarting the gateway.

The Basic Memory adapter remains narrow. It adds only the observed
`create_memory_project` mapping needed for this workflow; callers cannot supply
arbitrary backend tool names, workspaces, paths, or `set_default` behavior. A
compatibility test must first prove that the pinned backend creates a missing
project directory at the supplied path. If it does not, implementation stops for
an architecture revision rather than making the gateway vault mount writable.
Basic Memory 0.23.2 constrains project creation beneath
`BASIC_MEMORY_PROJECT_ROOT`, so the memory service sets that root to
`/app/data/Projects`. Existing static project mappings remain explicit, while
new dynamic projects cannot be normalized into the vault root.

An existing project returns `created: false`. If the same principal lacks a
grant, ensuring it adds the role-matched grant only after confirming that the
project is ready. A non-owner cannot use ensure to claim a static or reserved
scope.

## 7. Failure and recovery behavior

Provisioning crosses SQLite, the vault filesystem, and Basic Memory, so it is a
journaled state machine rather than an assumed atomic transaction.

- Failure before the registry reservation creates no project.
- Failure after reservation but before backend creation leaves a recoverable
  `provisioning` record; retry with the same idempotency key resumes it.
- If Basic Memory succeeds but the gateway loses confirmation, recovery lists
  projects and adopts the exact expected mapping only when its path matches.
- A conflicting backend name or path moves the record to
  `recovery_required`; it is never overwritten or silently adopted.
- A ready project with a missing directory or backend mapping is degraded and
  cannot accept writes until owner recovery repairs the invariant.
- Reusing an idempotency key with different normalized input remains an error.

Startup recovery checks unfinished project-provisioning operations before
declaring the gateway fully ready. Reads in unrelated ready scopes remain
available; mutations for the affected scope are refused with
`RECOVERY_REQUIRED`.

Deletion and automatic garbage collection are out of scope. Provisioning never
deletes a Basic Memory project, vault directory, note, grant, or registry row.

## 8. Runtime changes

The current runtime constructs several components from an immutable
`config.scopes` array. They must instead consume a scope-registry abstraction
that exposes:

- static configured scopes;
- ready dynamic project scopes;
- lookup by scope ID, repository identity, and configured alias;
- collision-safe insertion;
- authorization-filtered listing;
- a change notification or explicit refresh after provisioning.

The vault, catalogue, backend adapter, recall service, mutation coordinator, and
status service use this common registry. No component may maintain an
independent stale copy of project names.

`brain_status` continues to return only scopes visible to the caller. It also
reports a caller-visible project in `provisioning` or `recovery_required` state
without revealing projects owned by another principal.

## 9. MCP contract

The gateway exposes seven tools after this change. The new tool is:

```text
brain_project_ensure
```

Annotations:

- `readOnlyHint: false`
- `destructiveHint: false`
- `idempotentHint: true`
- `openWorldHint: false`

The success result includes:

- normalized repository identity;
- assigned scope;
- `created` boolean;
- role-matched permission booleans;
- provisioning operation ID;
- backend and materialization readiness;
- warnings, normally empty.

Expected stable errors include `INVALID_INPUT`, `FORBIDDEN`,
`BACKEND_UNAVAILABLE`, `CONFLICT`, and `RECOVERY_REQUIRED`. Responses never
echo remote credentials or absolute host paths.

## 10. Client behavior

Initialization guidance changes from "do not guess a project from a basename"
to the following workflow:

1. obtain `git remote get-url origin` in the current repository;
2. call `brain_project_ensure` once for the task or connection;
3. use the returned scope for subsequent memory calls;
4. if repository identity is unavailable, continue without project memory and
   state that persistent memory was not checked.

This is automatic for agents that honor MCP server instructions. Documentation
and client-specific instruction files remain the fallback because MCP servers
cannot inspect a client's working directory or force instruction delivery.

## 11. Migration and compatibility

- Existing `freellmapi`, `shared`, and `profile` scopes continue unchanged.
- Existing credentials and tokens remain valid without schema edits.
- Existing project notes and Basic Memory mappings are not moved.
- A migration may seed repository identity mappings for static project scopes
  only when an operator supplies an unambiguous identity. The gateway must not
  invent one from a basename.
- The current `freellmapi` reviewer continues to have its static rights.
- New setup creates `shared` and `profile` as reserved static scopes and does
  not require a named pilot project.
- Configuration retains an optional static `scopes` list for reserved scopes,
  migrations, aliases, and deliberately pre-provisioned deployments.

## 12. Security constraints

- Every ensure call requires a valid credential and is attributed to its
  principal ID.
- Provisioning is rate-limited per principal and globally bounded to prevent
  accidental project floods.
- Remote parsing accepts the conventional SSH username `git` but rejects URLs
  containing passwords, access tokens, or other embedded secret material; raw
  input is never logged.
- Generated paths pass the same traversal, canonical-root, and symlink checks as
  note materialization.
- Backend project creation uses a server-generated name and path only.
- `shared`, `profile`, configured static scopes, and their aliases cannot be
  claimed dynamically.
- Role-matched grants never elevate a worker to reviewer or a reviewer to owner.
- Notes remain untrusted data and cannot trigger provisioning.
- Project creation is not authorization for repository filesystem access; it
  creates only Second Brain storage and metadata.

## 13. Validation

### 13.1 Unit tests

- normalize HTTPS, `ssh://`, and scp-style remotes to one identity;
- reject remotes containing passwords or tokens, malformed remotes, traversal, encoded separators,
  missing repository paths, and reserved names;
- derive deterministic scopes and collision suffixes;
- derive exact worker, reviewer, and owner grants;
- validate the new request and result schemas;
- ensure secret-bearing input is redacted from diagnostics.

### 13.2 Integration tests

- first ensure creates registry state, directory, backend project, grant, and
  ready runtime scope;
- repeated ensure is idempotent;
- two principals receive independent role-matched grants;
- one principal cannot list or use another principal's project;
- token rotation preserving principal ID preserves dynamic grants;
- static and reserved scopes cannot be shadowed;
- scope collisions resolve deterministically;
- all existing tools can immediately use the returned scope without restart;
- interruption at every provisioning stage recovers or reports
  `RECOVERY_REQUIRED` without duplicate projects;
- malformed and conflicting backend results fail closed;
- concurrent ensures for one identity produce one project and stable receipts.

### 13.3 Docker end-to-end tests

- a clean deployment provisions a previously unknown Git repository through
  real public MCP and the pinned Basic Memory backend;
- the resulting note is materialized under `Projects/<scope>` and indexed;
- restart preserves identity mapping, grants, and retrieval;
- the backend remains unexposed;
- offline operation works after dependencies are warm;
- backup, restore verification, and catalogue rebuild retain dynamic project
  registry and grants.

### 13.4 Client pilot

With an approved external-model budget, run a Codex/OpenCode pilot from two
repositories. Record whether initialization guidance caused the agent to obtain
the Git remote, call ensure, use the returned scope, recall, and capture without
operator configuration. If the client ignores instructions, report that as a
client limitation rather than claiming full automation.

## 14. Acceptance criteria

The feature is complete when:

1. A user can open a previously unknown Git repository and an instruction-aware
   agent can provision its Second Brain project without operator file edits or a
   gateway restart.
2. HTTPS and SSH forms of the same remote resolve to one project.
3. Worker, reviewer, and owner callers receive exactly their role-matched
   project permissions.
4. Dynamic access is isolated by principal ID and survives token rotation and
   service restart.
5. `shared` and `profile` retain their existing owner-protected behavior.
6. Partial failure is recoverable and never leaves an apparently ready project
   with a missing or mismatched backend mapping.
7. Existing deployments, credentials, notes, and static scopes remain usable.
8. Relevant unit, integration, Docker, security, recovery, backup, and client
   pilot evidence is recorded with executed and not-run claims distinguished.

## 15. Out of scope

- discovering repositories by scanning host directories;
- using a local folder basename as repository identity;
- automatically deleting projects or notes;
- granting one non-owner principal access to another principal's project;
- organization-wide repository discovery or multi-user tenancy;
- changing protected review rules for `shared`, `profile`, preferences, or
  approved architecture decisions;
- guaranteeing that every MCP host follows server initialization instructions.
