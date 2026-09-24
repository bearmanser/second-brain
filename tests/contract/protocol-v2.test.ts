import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import {
  captureRequestSchema,
  captureRequestSchemaV2,
  noteReferenceSchema,
  readRequestSchema,
  recallRequestSchema,
  reviewRequestSchema,
  reviewRequestSchemaV2
} from '../../src/contracts/protocol.js';
import { notePathSchema, noteInputSchemaV2 } from '../../src/contracts/content.js';
import { RECALL_MODES } from '../../src/core/types.js';
import { buildInstructions } from '../../src/mcp/instructions.js';
import { legacyToolDefinitions, toolDefinitions } from '../../src/mcp/tools.js';
import { vaultNoteSegments } from '../../src/storage/vault.js';

const ID = '44b093c5-71db-4785-b9a5-bb8118304278';
const ETAG = 'a'.repeat(64);

const baseNote = {
  title: 'Decision note',
  tags: ['retrieval'],
  content: { kind: 'decision', context: 'c', decision: 'd', rationale: 'r' },
  evidence: [],
  related_ids: []
};

const flexibleNote = {
  title: 'Research note',
  tags: ['retrieval'],
  content: { kind: 'note', summary: 's', body_markdown: '# Research note\n' },
  evidence: [],
  related_ids: []
};

test('a read reference has exactly one selector', () => {
  expect(noteReferenceSchema.safeParse({ path: 'Knowledge/Laya.md' }).success).toBe(true);
  expect(noteReferenceSchema.safeParse({ title: 'Laya' }).success).toBe(true);
  expect(noteReferenceSchema.safeParse({ id: ID }).success).toBe(true);
  expect(
    noteReferenceSchema.safeParse({ id: ID, path: 'Knowledge/Laya.md' }).success
  ).toBe(false);
  expect(noteReferenceSchema.safeParse({}).success).toBe(false);
});

test('brain_read rejects ambiguous selectors and requires a managed id for history', () => {
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya.md' }).success).toBe(true);
  expect(readRequestSchema.safeParse({ title: 'Laya' }).success).toBe(true);
  expect(readRequestSchema.safeParse({ id: ID, title: 'Laya' }).success).toBe(false);
  expect(readRequestSchema.safeParse({}).success).toBe(false);
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya.md', revision_id: ID }).success).toBe(
    false
  );
  expect(readRequestSchema.safeParse({ id: ID, revision_id: ID }).success).toBe(true);
});

test('brain_recall accepts text, reranked, and the deprecated hybrid alias', () => {
  expect(RECALL_MODES).toEqual(['text', 'reranked', 'hybrid']);
  for (const mode of RECALL_MODES) {
    expect(recallRequestSchema.safeParse({ query: 'alpha', mode }).success).toBe(true);
  }
  expect(recallRequestSchema.safeParse({ query: 'alpha', mode: 'semantic' }).success).toBe(false);
});

test('brain_review accepts explicit move and adopt actions', () => {
  const move = reviewRequestSchema.safeParse({
    operation: {
      action: 'move',
      idempotency_key: ID,
      id: ID,
      target_path: 'Knowledge/Moved.md',
      expected_etag: 'a'.repeat(64),
      rationale: 'relocate'
    }
  });
  expect(move.success).toBe(true);
  const adopt = reviewRequestSchema.safeParse({
    operation: {
      action: 'adopt',
      idempotency_key: ID,
      path: 'Knowledge/Plain.md',
      expected_etag: 'a'.repeat(64),
      rationale: 'adopt a plain note'
    }
  });
  expect(adopt.success).toBe(true);
});

test('legacy capture validation stays bound to the frozen V1 schema', () => {
  expect(captureRequestSchema.safeParse({ idempotency_key: ID, note: baseNote }).success).toBe(true);
  expect(
    captureRequestSchema.safeParse({ idempotency_key: ID, note: { ...baseNote, type: 'decision' } })
      .success
  ).toBe(false);
  expect(
    captureRequestSchema.safeParse({ idempotency_key: ID, note: { ...baseNote, source: 'self' } })
      .success
  ).toBe(false);
  expect(
    captureRequestSchemaV2.safeParse({
      idempotency_key: ID,
      note: {
        ...baseNote,
        content: { kind: 'note', summary: 's', body_markdown: '# s\n' },
        type: 'research'
      }
    }).success
  ).toBe(true);
});

test('V2 capture accepts the additive type/source fields and enforces the type/content relationship', () => {
  expect(
    captureRequestSchemaV2.safeParse({
      idempotency_key: ID,
      note: { ...baseNote, type: 'decision', source: 'self-reported' }
    }).success
  ).toBe(true);
  expect(
    captureRequestSchemaV2.safeParse({ idempotency_key: ID, note: { ...flexibleNote, type: 'research' } })
      .success
  ).toBe(true);
  expect(
    captureRequestSchemaV2.safeParse({ idempotency_key: ID, note: { ...baseNote, type: 'research' } })
      .success
  ).toBe(false);
  expect(
    captureRequestSchemaV2.safeParse({ idempotency_key: ID, note: { ...flexibleNote, type: 'decision' } })
      .success
  ).toBe(false);
  expect(noteInputSchemaV2.safeParse({ ...baseNote, type: 'not-a-type' }).success).toBe(false);
});

test('V2 review carries the additive note fields while the legacy review schema does not', () => {
  const legacy = reviewRequestSchema.safeParse({
    operation: {
      action: 'revise',
      idempotency_key: ID,
      id: ID,
      expected_etag: ETAG,
      rationale: 'revise',
      note: { ...baseNote, type: 'decision' }
    }
  });
  expect(legacy.success).toBe(false);
  const v2 = reviewRequestSchemaV2.safeParse({
    operation: {
      action: 'revise',
      idempotency_key: ID,
      id: ID,
      expected_etag: ETAG,
      rationale: 'revise',
      note: { ...baseNote, type: 'decision', source: 'self' }
    }
  });
  expect(v2.success).toBe(true);
});

test('the shared note path contract matches the vault constraints', () => {
  expect(notePathSchema.safeParse('Knowledge/Laya.md').success).toBe(true);
  expect(notePathSchema.safeParse('Projects/Second Brain/Research/Læring.md').success).toBe(true);
  expect(notePathSchema.safeParse('/Knowledge/Laya.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge\\Laya.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/.hidden/Laya.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/Laya').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/Laya\u0007.md').success).toBe(false);
  expect(notePathSchema.safeParse('Knowledge/../Laya.md').success).toBe(false);
});

test('read, move, and adopt agree on the shared note path contract', () => {
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya' }).success).toBe(false);
  expect(
    reviewRequestSchema.safeParse({
      operation: {
        action: 'move',
        idempotency_key: ID,
        id: ID,
        target_path: '.hidden/Moved.md',
        expected_etag: ETAG,
        rationale: 'relocate'
      }
    }).success
  ).toBe(false);
  expect(
    reviewRequestSchema.safeParse({
      operation: {
        action: 'adopt',
        idempotency_key: ID,
        path: 'Knowledge/Plain',
        expected_etag: ETAG,
        rationale: 'adopt'
      }
    }).success
  ).toBe(false);
  expect(readRequestSchema.safeParse({ path: 'Knowledge/Laya.md' }).success).toBe(true);
  expect(
    reviewRequestSchema.safeParse({
      operation: {
        action: 'move',
        idempotency_key: ID,
        id: ID,
        target_path: 'Knowledge/Moved.md',
        expected_etag: ETAG,
        rationale: 'relocate'
      }
    }).success
  ).toBe(true);
});

test('read, move, and adopt never silently change the identity of a supplied path', () => {
  const paths = [' Knowledge/Laya.md', 'Knowledge/Laya.md ', 'Knowledge/ Laya.md'];
  for (const path of paths) {
    const accepted = notePathSchema.safeParse(path);
    const read = readRequestSchema.safeParse({ path });
    const move = reviewRequestSchemaV2.safeParse({
      operation: {
        action: 'move', idempotency_key: ID, id: ID, target_path: path,
        expected_etag: ETAG, rationale: 'relocate'
      }
    });
    const adopt = reviewRequestSchemaV2.safeParse({
      operation: {
        action: 'adopt', idempotency_key: ID, path,
        expected_etag: ETAG, rationale: 'adopt'
      }
    });
    for (const result of [accepted, read, move, adopt]) {
      if (result.success) {
        const parsed = result.data as string | { path?: string; operation?: { path?: string; target_path?: string } };
        expect(typeof parsed === 'string' ? parsed : parsed.path ?? parsed.operation?.path ?? parsed.operation?.target_path).toBe(path);
      }
    }
    if (path.endsWith(' ')) {
      expect(() => vaultNoteSegments(path)).toThrow();
      expect(accepted.success).toBe(false);
      expect(read.success).toBe(false);
      expect(move.success).toBe(false);
      expect(adopt.success).toBe(false);
    } else {
      expect(vaultNoteSegments(path).join('/')).toBe(path);
      expect(accepted.success).toBe(true);
      expect(read.success).toBe(true);
      expect(move.success).toBe(true);
      expect(adopt.success).toBe(true);
    }
  }
});

test('a leading-space vault segment is an exact, distinct read, move and adopt identity', () => {
  const path = ' Knowledge/Laya.md';
  expect(vaultNoteSegments(path)).toEqual([' Knowledge', 'Laya.md']);
  expect(notePathSchema.parse(path)).toBe(path);
  expect(readRequestSchema.parse({ path }).path).toBe(path);
  expect(reviewRequestSchemaV2.parse({
    operation: { action: 'move', idempotency_key: ID, id: ID, target_path: path, expected_etag: ETAG, rationale: 'relocate' }
  }).operation).toMatchObject({ target_path: path });
  expect(reviewRequestSchemaV2.parse({
    operation: { action: 'adopt', idempotency_key: ID, path, expected_etag: ETAG, rationale: 'adopt' }
  }).operation).toMatchObject({ path });
  expect(notePathSchema.parse('Knowledge/Laya.md')).not.toBe(path);
});

test('V2 public tool schemas carry no permission or backend fields while legacy schemas do', () => {
  const forbidden = /permission|can_read|can_write|can_review|authorized_scopes|backend_ready|backend_project|"embeddings"/;
  for (const definition of toolDefinitions) {
    expect(JSON.stringify(definition.outputSchema), definition.name).not.toMatch(forbidden);
  }
  const statusV2 = toolDefinitions.find((definition) => definition.name === 'brain_status')?.outputSchema as {
    properties: { protocol?: unknown; scopes?: unknown; health?: { properties?: Record<string, unknown> } };
  };
  expect(statusV2.properties.protocol).toMatchObject({ const: 2 });
  expect(statusV2.properties).not.toHaveProperty('scopes');
  expect(statusV2.properties.health?.properties).not.toHaveProperty('backend');
  expect(statusV2.properties.health?.properties).not.toHaveProperty('embeddings');

  const ensureV1 = legacyToolDefinitions.find(
    (definition) => definition.name === 'brain_project_ensure'
  )?.outputSchema as { required?: string[] };
  expect(ensureV1.required).toContain('backend_ready');
  const statusV1 = JSON.stringify(
    legacyToolDefinitions.find((definition) => definition.name === 'brain_status')?.outputSchema
  );
  expect(statusV1).toContain('"backend"');
  expect(statusV1).toContain('"embeddings"');
});

test('the shipped instructions describe the role-free contract, candidates, fallback, and readable sources', () => {
  const text = buildInstructions();
  expect(text).toContain('there are no roles or permissions');
  expect(text).toContain('typed candidates');
  expect(text).toContain('fallback');
  expect(text).toContain('a managed id, a vault-relative path, or an unambiguous title');
});

test('the example opencode configuration is valid JSONC for the single-token V2 surface', async () => {
  const text = await readFile(new URL('../../config/opencode.example.jsonc', import.meta.url), 'utf8');
  const json = text
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const parsed = JSON.parse(json) as {
    mcp: {
      servers: Record<
        string,
        { type: string; url: string; oauth: boolean; codemode: boolean; headers: Record<string, string> }
      >;
    };
  };
  const server = parsed.mcp.servers['second-brain'];
  expect(server.type).toBe('remote');
  expect(server.url).toBe('http://127.0.0.1:7331/mcp');
  expect(server.oauth).toBe(false);
  expect(server.codemode).toBe(false);
  expect(server.headers.Authorization).toBe('Bearer {env:SECOND_BRAIN_TOKEN}');
});
