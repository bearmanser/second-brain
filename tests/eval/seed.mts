import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CaptureRequest, NoteInput } from '../../src/core/types.js';
import { structuredContent } from './io.mjs';

export interface CorpusNote {
  key: string;
  scope: string;
  status: 'candidate' | 'active' | 'superseded' | 'archived';
  replacement?: string;
  categories?: string[];
  note: NoteInput;
}

export interface CorpusFile {
  version: number;
  notes: CorpusNote[];
}

export interface SeedRegistry {
  by_id: Map<string, string>;
  by_key: Map<string, string>;
  timeline: string[];
}

export interface SeedOptions {
  keys?: string[];
}

export type SeedRole = 'worker' | 'reviewer' | 'owner';

export interface SeedConnectionProvider {
  connect(role: SeedRole, name?: string): Promise<Client>;
}

type SeedClients = Record<SeedRole, Client>;

function scopeRole(entry: CorpusNote): SeedRole {
  return entry.scope === 'freellmapi' ? 'worker' : 'owner';
}

function approverRole(entry: CorpusNote): SeedRole {
  return entry.scope === 'freellmapi' ? 'reviewer' : 'owner';
}

async function captureNote(client: Client, entry: CorpusNote): Promise<Record<string, unknown>> {
  const request: CaptureRequest = {
    idempotency_key: randomUUID(),
    scope: entry.scope,
    note: entry.note
  };
  const result = await client.callTool({
    name: 'brain_capture',
    arguments: request as unknown as Record<string, unknown>
  });
  const structured = structuredContent(result);
  if (structured.id === undefined) throw new Error(`capture of ${entry.key} returned no id`);
  return structured;
}

async function approveNote(
  client: Client,
  entry: CorpusNote,
  id: string,
  expectedEtag: string
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'brain_review',
    arguments: {
      scope: entry.scope,
      operation: {
        action: 'approve',
        idempotency_key: randomUUID(),
        id,
        expected_etag: expectedEtag,
        rationale: 'evaluation corpus approval'
      }
    }
  });
  const structured = structuredContent(result);
  if (structured.outcome !== 'stored') {
    throw new Error(`approval of ${entry.key} returned ${String(structured.outcome)}`);
  }
  return structured;
}

async function supersedeNote(
  client: Client,
  entry: CorpusNote,
  id: string,
  expectedEtag: string,
  replacementId: string
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'brain_review',
    arguments: {
      scope: entry.scope,
      operation: {
        action: 'supersede',
        idempotency_key: randomUUID(),
        id,
        expected_etag: expectedEtag,
        rationale: 'evaluation corpus supersession',
        replacement_id: replacementId
      }
    }
  });
  return structuredContent(result);
}

async function seedNote(
  entry: CorpusNote,
  corpus: CorpusNote[],
  registry: SeedRegistry,
  clients: SeedClients
): Promise<void> {
  const captured = await captureNote(clients[scopeRole(entry)], entry);
  const id = String(captured.id);
  registry.timeline.push(`brain_capture:${entry.key}`);
  registry.by_id.set(id, entry.key);
  registry.by_key.set(entry.key, id);
  if (entry.status === 'candidate') return;

  const approved = await approveNote(clients[approverRole(entry)], entry, id, String(captured.etag));
  registry.timeline.push(`brain_review:approve:${entry.key}`);
  if (entry.status !== 'superseded') return;

  const replacementKey = entry.replacement;
  if (replacementKey === undefined) {
    throw new Error(`superseded note ${entry.key} has no replacement`);
  }
  const replacementId = registry.by_key.get(replacementKey);
  if (replacementId === undefined) {
    throw new Error(`replacement ${replacementKey} was not seeded first`);
  }
  const superseded = await supersedeNote(
    clients.reviewer,
    entry,
    id,
    String(approved.etag),
    replacementId
  );
  if (superseded.outcome !== 'stored') {
    throw new Error(`supersede of ${entry.key} did not store`);
  }
  registry.timeline.push(`brain_review:supersede:${entry.key}`);
}

export async function seedCorpus(
  provider: SeedConnectionProvider,
  corpus: CorpusFile,
  registry: SeedRegistry,
  options: SeedOptions = {}
): Promise<void> {
  const worker = await provider.connect('worker', 'second-brain-eval-seed-worker');
  const reviewer = await provider.connect('reviewer', 'second-brain-eval-seed-reviewer');
  const owner = await provider.connect('owner', 'second-brain-eval-seed-owner');
  try {
    const selected =
      options.keys === undefined
        ? corpus.notes
        : corpus.notes.filter((entry) => options.keys?.includes(entry.key) === true);
    const ordered = [...selected].sort(
      (left, right) =>
        Number(left.status === 'superseded') - Number(right.status === 'superseded')
    );
    for (const entry of ordered) {
      await seedNote(entry, selected, registry, { worker, reviewer, owner });
    }
  } finally {
    await Promise.allSettled([worker.close(), reviewer.close(), owner.close()]);
  }
}

export function httpSeedProvider(harness: {
  token: string;
  reviewerToken: string;
  ownerToken: string;
  connect(token: string, name?: string): Promise<Client>;
}): SeedConnectionProvider {
  const tokenFor: Record<SeedRole, string> = {
    worker: harness.token,
    reviewer: harness.reviewerToken,
    owner: harness.ownerToken
  };
  return {
    connect: (role: SeedRole, name?: string) => harness.connect(tokenFor[role], name)
  };
}

export function dockerSeedProvider(harness: {
  connect(principalId: string, name?: string): Promise<Client>;
}): SeedConnectionProvider {
  const principalFor: Record<SeedRole, string> = {
    worker: 'project-worker',
    reviewer: 'project-reviewer',
    owner: 'owner'
  };
  return {
    connect: (role: SeedRole, name?: string) => harness.connect(principalFor[role], name)
  };
}
