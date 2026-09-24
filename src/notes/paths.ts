import { BrainError } from '../contracts/errors.js';

export const BASENAME_MAX_BYTES = 100;
export const VAULT_PATH_MAX_BYTES = 220;
export const PROJECTS_ROOT = 'Projects';
export const NOTE_EXTENSION = '.md';

const MAX_COLLISION_SUFFIX = 10_000;
const REPLACEMENT_CHARACTER = '\uFFFD';

const DISALLOWED_RUN = /[<>:"/\\|?*\u0000-\u001f\u007f#[\]^]+/gu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const TRAILING = /[. ]+$/u;
const LEADING_DOTS = /^[. ]+/u;
const WINDOWS_RESERVED_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/iu;
const DIRECTORY_SEGMENT_FORBIDDEN = /[<>:"\\|?*\u0000-\u001f\u007f#[\]^]/u;
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const LONE_SURROGATE_RUN = /[\uD800-\uDFFF]/gu;

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

export function collisionKey(path: string): string {
  return path.normalize('NFC').toLocaleLowerCase('en-US');
}

function replaceLoneSurrogates(value: string): string {
  return value.replace(LONE_SURROGATE_RUN, REPLACEMENT_CHARACTER);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let bytes = 0;
  let result = '';
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += character;
  }
  return result;
}

function fitName(value: string, maxBytes: number): string {
  return truncateUtf8(value, maxBytes).replace(TRAILING, '');
}

function avoidWindowsDevice(value: string): string {
  if (value.length === 0) return value;
  const dot = value.indexOf('.');
  const rawHead = dot === -1 ? value : value.slice(0, dot);
  const head = rawHead.replace(TRAILING, '');
  if (!WINDOWS_RESERVED_DEVICE.test(head)) return value;
  return `${rawHead}_${dot === -1 ? '' : value.slice(dot)}`;
}

function fittedStem(stem: string, maxBytes: number): string | undefined {
  if (maxBytes < 1) return undefined;
  let candidate = fitName(stem, maxBytes);
  if (candidate.length === 0) candidate = fitName('Note', maxBytes);
  if (candidate.length === 0) return undefined;
  let safe = avoidWindowsDevice(candidate);
  if (Buffer.byteLength(safe, 'utf8') <= maxBytes) return safe;
  if (maxBytes < 2) return undefined;
  const reduced = fitName(candidate, maxBytes - 1);
  if (reduced.length === 0) return undefined;
  safe = avoidWindowsDevice(reduced);
  return Buffer.byteLength(safe, 'utf8') <= maxBytes ? safe : undefined;
}

function sanitizeName(value: string): string {
  const replaced = replaceLoneSurrogates(value)
    .normalize('NFC')
    .replace(DISALLOWED_RUN, ' ');
  const collapsed = replaced.replace(/\s+/gu, ' ').trim();
  const stripped = collapsed.replace(LEADING_DOTS, '').replace(TRAILING, '');
  return avoidWindowsDevice(stripped);
}

export function safeBasename(title: string): string {
  if (typeof title !== 'string') throw invalidInput('a note title must be a string');
  const cleaned = sanitizeName(title);
  if (cleaned.length === 0) return 'Note';
  return fittedStem(cleaned, BASENAME_MAX_BYTES) ?? 'Note';
}

export function safeNoteFilename(title: string): string {
  const stem = safeBasename(title);
  const maxStem = BASENAME_MAX_BYTES - NOTE_EXTENSION.length;
  const fitted = fittedStem(stem, maxStem) ?? 'Note';
  return `${fitted}${NOTE_EXTENSION}`;
}

function assertSafeDirectory(directory: string): string {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw invalidInput('a vault directory must be a non-empty relative path');
  }
  if (LONE_SURROGATE.test(directory)) {
    throw invalidInput('a vault directory contains invalid UTF-16');
  }
  if (Buffer.byteLength(directory, 'utf8') > VAULT_PATH_MAX_BYTES) {
    throw invalidInput('a vault directory exceeds the vault path limit');
  }
  if (directory.startsWith('/') || directory.startsWith('\\') || directory.includes('\\')) {
    throw invalidInput('a vault directory must be a relative POSIX path');
  }
  if (CONTROL.test(directory)) {
    throw invalidInput('a vault directory contains a control character');
  }
  for (const segment of directory.split('/')) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.')
    ) {
      throw invalidInput('a vault directory contains an unsafe segment');
    }
    if (segment !== segment.trim() || TRAILING.test(segment)) {
      throw invalidInput('a vault directory segment has forbidden surrounding characters');
    }
    if (DIRECTORY_SEGMENT_FORBIDDEN.test(segment)) {
      throw invalidInput('a vault directory segment contains a reserved character');
    }
    const head = segment.split('.')[0] ?? segment;
    if (WINDOWS_RESERVED_DEVICE.test(head)) {
      throw invalidInput('a vault directory segment is a reserved Windows device name');
    }
  }
  return directory.normalize('NFC');
}

function normalizeOccupied(occupied: readonly string[]): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(occupied)) {
    for (const entry of occupied) {
      if (typeof entry === 'string' && entry.length > 0) {
        keys.add(collisionKey(replaceLoneSurrogates(entry)));
      }
    }
  }
  return keys;
}

export function allocateNotePath(input: {
  directory: string;
  title: string;
  occupied: string[];
}): string {
  const directory = assertSafeDirectory(input?.directory);
  const occupied = normalizeOccupied(input?.occupied ?? []);
  const stem = safeBasename(input?.title);
  const fixed = Buffer.byteLength(directory, 'utf8') + 1 + NOTE_EXTENSION.length;
  if (VAULT_PATH_MAX_BYTES - fixed < 1) {
    throw invalidInput('the destination directory leaves no room for a note name');
  }
  for (let index = 0; index < MAX_COLLISION_SUFFIX; index += 1) {
    const suffix = index === 0 ? '' : ` (${index + 1})`;
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    const maxStem = Math.min(
      BASENAME_MAX_BYTES - suffixBytes - NOTE_EXTENSION.length,
      VAULT_PATH_MAX_BYTES - fixed - suffixBytes
    );
    const fitted = fittedStem(stem, maxStem);
    if (fitted === undefined) {
      throw invalidInput('the destination directory leaves no room for a valid note name');
    }
    const candidate = `${directory}/${fitted}${suffix}${NOTE_EXTENSION}`;
    if (!occupied.has(collisionKey(candidate))) return candidate;
  }
  throw conflict('unable to allocate a unique note path');
}

export function allocateProjectRoot(displayName: string, occupied: string[]): string {
  if (typeof displayName !== 'string') {
    throw invalidInput('a project display name must be a string');
  }
  const cleaned = sanitizeName(displayName.normalize('NFC').trim());
  if (cleaned.length === 0) {
    throw invalidInput('a project display name must contain a usable character');
  }
  const occupiedRoots = normalizeOccupied(occupied ?? []);
  const prefix = `${PROJECTS_ROOT}/`;
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');
  for (let index = 0; index < MAX_COLLISION_SUFFIX; index += 1) {
    const suffix = index === 0 ? '' : ` (${index + 1})`;
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    const maxSegment = Math.min(
      BASENAME_MAX_BYTES - suffixBytes,
      VAULT_PATH_MAX_BYTES - prefixBytes - suffixBytes
    );
    const fitted = fittedStem(cleaned, maxSegment);
    if (fitted === undefined) {
      throw invalidInput('a project root cannot fit inside the vault path limit');
    }
    const candidate = `${prefix}${fitted}${suffix}`;
    if (!occupiedRoots.has(collisionKey(candidate))) return candidate;
  }
  throw conflict('unable to allocate a unique project root');
}
