import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { planRename, type RenameFileSnapshot } from '../../src/notes/rename.js';

function snapshot(path: string, raw: string): RenameFileSnapshot {
  return { path, raw, hash: createHash('sha256').update(raw).digest('hex') };
}

test('a rename rewrites references, not matching code strings', () => {
  const raw = '[[Knowledge/Laya#Limits|Classifier]]\n`[[Knowledge/Laya]]`\n';
  const target = '# Laya\n\n## Limits\n';
  const files = [
    { path: 'Home.md', raw, hash: createHash('sha256').update(raw).digest('hex') },
    { path: 'Knowledge/Laya.md', raw: target, hash: createHash('sha256').update(target).digest('hex') }
  ];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/Laya classifier.md', files });
  expect(plan.edits.find(x => x.path === 'Home.md')?.raw).toBe(
    '[[Knowledge/Laya classifier#Limits|Classifier]]\n`[[Knowledge/Laya]]`\n'
  );
});

test('fenced code and inline code keep their brackets while prose is rewritten', () => {
  const raw =
    '[[Knowledge/Laya|Laya]]\n```text\n[[Knowledge/Laya]]\n```\ninline `[[Knowledge/Laya]]` too\n';
  const files = [
    snapshot('Home.md', raw),
    snapshot('Knowledge/Laya.md', '# Laya\n')
  ];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/Laya classifier.md', files });
  expect(plan.edits.find(x => x.path === 'Home.md')?.raw).toBe(
    '[[Knowledge/Laya classifier|Laya]]\n```text\n[[Knowledge/Laya]]\n```\ninline `[[Knowledge/Laya]]` too\n'
  );
});

test('a move across project folders rewrites the canonical path but keeps label and fragment', () => {
  const raw = 'See [[Knowledge/Laya#Limits|the classifier]] for details.\n';
  const files = [snapshot('Inbox/Home.md', raw), snapshot('Knowledge/Laya.md', '# Laya\n')];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Personal/Laya.md', files });
  expect(plan.edits.find(x => x.path === 'Inbox/Home.md')?.raw).toBe(
    'See [[Personal/Laya#Limits|the classifier]] for details.\n'
  );
});

test('a case-only rename is planned as a case-safe two-step move', () => {
  const raw = '[[Knowledge/Laya]]\n';
  const files = [snapshot('Home.md', raw), snapshot('Knowledge/Laya.md', '# Laya\n')];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/laya.md', files });
  expect(plan.moves).toHaveLength(2);
  expect(plan.moves[0].from).toBe('Knowledge/Laya.md');
  expect(plan.moves[1].to).toBe('Knowledge/laya.md');
  expect(plan.moves[0].to).not.toBe('Knowledge/laya.md');
  expect(plan.moves[1].from).toBe(plan.moves[0].to);
  expect(plan.edits.find(x => x.path === 'Home.md')?.raw).toBe('[[Knowledge/laya]]\n');
});

test('an occupied target is reported as a conflict and produces no edits', () => {
  const files = [
    snapshot('Home.md', '[[Knowledge/Laya]]\n'),
    snapshot('Knowledge/Laya.md', '# Laya\n'),
    snapshot('Knowledge/Laya classifier.md', '# Occupied\n')
  ];
  const plan = planRename({
    from: 'Knowledge/Laya.md',
    to: 'Knowledge/Laya classifier.md',
    files
  });
  expect(plan.conflicts.some(entry => entry.reason === 'target_occupied')).toBe(true);
});

test('an attachment embed is rewritten and keeps its extension', () => {
  const raw = '![[Attachments/diagram.png]]\n';
  const files = [snapshot('Home.md', raw), snapshot('Attachments/diagram.png', 'PNG')];
  const plan = planRename({
    from: 'Attachments/diagram.png',
    to: 'Attachments/diagram final.png',
    files
  });
  expect(plan.edits.find(x => x.path === 'Home.md')?.raw).toBe('![[Attachments/diagram final.png]]\n');
});

test('a deleted target is reported unresolved and left byte-for-byte untouched', () => {
  const raw = '[[Knowledge/Gone]] and [[Knowledge/Laya]]\n';
  const files = [snapshot('Home.md', raw), snapshot('Knowledge/Laya.md', '# Laya\n')];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/Laya.md'.replace('Laya', 'Laya two'), files });
  expect(plan.edits.find(x => x.path === 'Home.md')?.raw).toBe('[[Knowledge/Gone]] and [[Knowledge/Laya two]]\n');
  expect(plan.unresolved.some(entry => entry.target === 'Knowledge/Gone')).toBe(true);
});

test('an ambiguous short name is never guessed', () => {
  const files = [
    snapshot('Home.md', '[[Laya]]\n'),
    snapshot('A/Laya.md', '# A\n'),
    snapshot('B/Laya.md', '# B\n')
  ];
  const plan = planRename({ from: 'A/Laya.md', to: 'A/Laya two.md', files });
  expect(plan.edits.find(x => x.path === 'Home.md')).toBeUndefined();
  expect(plan.unresolved.some(entry => entry.reason === 'ambiguous')).toBe(true);
});

test('a relative markdown link in a moved note is rebased for its new folder', () => {
  const from = 'Knowledge/Sub/Laya.md';
  const to = 'Archive/Laya.md';
  const movedRaw = '# Laya\n\n[Other](../Other.md)\n';
  const files = [
    snapshot('Knowledge/Other.md', '# Other\n'),
    snapshot(from, movedRaw)
  ];
  const plan = planRename({ from, to, files });
  expect(plan.edits.find(x => x.path === from)?.raw).toBe('# Laya\n\n[Other](../Knowledge/Other.md)\n');
});

test('a relative markdown link to the moved note is rebased from its unchanged source', () => {
  const files = [
    snapshot('Knowledge/Sub/Home.md', '[Laya](Laya.md)\n'),
    snapshot('Knowledge/Sub/Laya.md', '# Laya\n')
  ];
  const plan = planRename({ from: 'Knowledge/Sub/Laya.md', to: 'Archive/Laya.md', files });
  expect(plan.edits.find(x => x.path === 'Knowledge/Sub/Home.md')?.raw).toBe(
    '[Laya](../../Archive/Laya.md)\n'
  );
});

test('a canvas file node keeps its id and layout while its path is rewritten', () => {
  const canvasRaw = `${JSON.stringify(
    {
      nodes: [
        { id: 'node-1', type: 'file', file: 'Knowledge/Laya.md', x: 10, y: 20, width: 400, height: 200 },
        { id: 'node-2', type: 'text', text: 'see [[Knowledge/Laya#Limits]]', x: 30, y: 40 }
      ],
      edges: []
    },
    null,
    2
  )}\n`;
  const files = [
    snapshot('Views/Board.canvas', canvasRaw),
    snapshot('Knowledge/Laya.md', '# Laya\n')
  ];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/Laya classifier.md', files });
  const edited = plan.edits.find(x => x.path === 'Views/Board.canvas');
  expect(edited).toBeDefined();
  const parsed = JSON.parse(edited!.raw) as {
    nodes: Array<Record<string, unknown>>;
  };
  expect(parsed.nodes[0]).toMatchObject({
    id: 'node-1',
    type: 'file',
    file: 'Knowledge/Laya classifier.md',
    x: 10,
    y: 20,
    width: 400,
    height: 200
  });
  expect(parsed.nodes[1].text).toContain('[[Knowledge/Laya classifier#Limits]]');
  expect(parsed.nodes[1].id).toBe('node-2');
});

test('a base rewrites a supported link but reports an unsupported formula', () => {
  const baseRaw = [
    'filters:',
    '  and:',
    '    - \'file.path == "Knowledge/Laya.md"\'',
    'properties:',
    '  related: "[[Knowledge/Laya]]"',
    ''
  ].join('\n');
  const files = [snapshot('Views/Laya.base', baseRaw), snapshot('Knowledge/Laya.md', '# Laya\n')];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/Laya classifier.md', files });
  const edited = plan.edits.find(x => x.path === 'Views/Laya.base');
  expect(edited).toBeDefined();
  expect(edited!.raw).toContain('file.path == "Knowledge/Laya.md"');
  expect(edited!.raw).toContain('Knowledge/Laya classifier');
  expect(plan.unresolved.some(entry => entry.path === 'Views/Laya.base')).toBe(true);
});

test('obsidian configuration is reported for manual attention and never edited', () => {
  const bookmarks = `${JSON.stringify(
    { items: [{ type: 'file', path: 'Knowledge/Laya.md', title: 'Laya' }] },
    null,
    2
  )}\n`;
  const files = [
    snapshot('.obsidian/bookmarks.json', bookmarks),
    snapshot('Knowledge/Laya.md', '# Laya\n')
  ];
  const plan = planRename({ from: 'Knowledge/Laya.md', to: 'Knowledge/Laya classifier.md', files });
  expect(plan.edits.find(x => x.path === '.obsidian/bookmarks.json')).toBeUndefined();
  expect(
    plan.unresolved.some(entry => entry.path === '.obsidian/bookmarks.json' && entry.reason === 'manual')
  ).toBe(true);
});
