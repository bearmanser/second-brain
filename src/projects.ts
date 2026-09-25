import { conflict, invalidInput, notFound } from './errors.js';
import { parseNote, renderProjectNote } from './vault/note-file.js';
import { projectNotePath, sanitizeFileStem, slugify, withCollisionSuffix } from './vault/paths.js';
import type { Vault } from './vault/vault.js';

export interface Project {
  name: string;
  key: string;
  repositories: string[];
  notePath: string;
  hasNote: boolean;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATOR = /%(?:2f|5c)/i;
const RAW_TRAVERSAL_SEGMENT = /[/:](?:\.|%2e)(?:\.|%2e)?(?=\/|$)/i;
const SCP_REMOTE = /^([A-Za-z0-9._-]+)@([^:/\s]+):(.+)$/;

const invalidRemote = () =>
  invalidInput('remote_url must be an HTTPS or SSH git remote without credentials, query, or fragment');

function normalizeRemotePath(rawPath: string): string {
  if (ENCODED_SEPARATOR.test(rawPath) || rawPath.includes('\\')) throw invalidRemote();
  const trimmed = rawPath.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) throw invalidRemote();
  const segments = trimmed.split('/').map((segment) => {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw invalidRemote();
    }
    if (value.length === 0 || value === '.' || value === '..' || value.includes('/') || value.includes('\\') ||
      CONTROL_CHARACTERS.test(value)) {
      throw invalidRemote();
    }
    return value;
  });
  const repository = segments[segments.length - 1].replace(/\.git$/i, '');
  if (repository.length === 0 || repository === '.' || repository === '..') throw invalidRemote();
  segments[segments.length - 1] = repository;
  return segments.join('/');
}

export function normalizeRemote(remoteUrl: string): string {
  if (remoteUrl.length === 0 || remoteUrl !== remoteUrl.trim() || CONTROL_CHARACTERS.test(remoteUrl) ||
    ENCODED_SEPARATOR.test(remoteUrl) || RAW_TRAVERSAL_SEGMENT.test(remoteUrl) || remoteUrl.includes('?') ||
    remoteUrl.includes('#')) {
    throw invalidRemote();
  }
  const scp = SCP_REMOTE.exec(remoteUrl);
  if (scp !== null) {
    if (scp[1] !== 'git') throw invalidRemote();
    let hostname: string;
    try {
      hostname = new URL(`ssh://${scp[1]}@${scp[2]}`).hostname;
    } catch {
      throw invalidRemote();
    }
    if (hostname.length === 0) throw invalidRemote();
    return `${hostname.toLowerCase()}/${normalizeRemotePath(scp[3])}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw invalidRemote();
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') throw invalidRemote();
  if (parsed.password.length > 0) throw invalidRemote();
  if (parsed.protocol === 'https:' && parsed.username.length > 0) throw invalidRemote();
  if (parsed.protocol === 'ssh:' && parsed.username !== 'git') throw invalidRemote();
  if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.hostname.length === 0) throw invalidRemote();
  const port = parsed.protocol === 'ssh:' && parsed.port === '22' ? '' : parsed.port;
  const host = port.length > 0 ? `${parsed.hostname}:${port}` : parsed.hostname;
  return `${host.toLowerCase()}/${normalizeRemotePath(parsed.pathname)}`;
}

export class Projects {
  constructor(private readonly vault: Vault) {}

  private load(name: string): Project {
    const notePath = projectNotePath(name);
    let repositories: string[] = [];
    let hasNote = false;
    if (this.vault.exists(notePath)) {
      try {
        const parsed = parseNote(this.vault.read(notePath));
        if (parsed.isProject) {
          hasNote = true;
          repositories = parsed.repositories;
        }
      } catch {
        hasNote = false;
      }
    }
    return { name, key: slugify(name), repositories, notePath, hasNote };
  }

  list(): Project[] {
    return this.vault.projectFolders().map((name) => this.load(name));
  }

  resolve(nameOrKey: string): Project {
    const wanted = nameOrKey.trim().toLowerCase();
    const matches = this.list().filter((project) => project.name.toLowerCase() === wanted || project.key === wanted);
    if (matches.length === 0) throw notFound(`project not found: ${nameOrKey}`);
    if (matches.length > 1) {
      throw conflict(`project "${nameOrKey}" is ambiguous: ${matches.map((project) => project.name).join(', ')}`);
    }
    return matches[0];
  }

  ensure(remoteUrl: string): { project: Project; created: boolean } {
    const identity = normalizeRemote(remoteUrl);
    const projects = this.list();
    const bound = projects.find((project) => project.repositories.includes(identity));
    if (bound !== undefined) return { project: bound, created: false };

    const base = sanitizeFileStem(identity.split('/').at(-1) ?? '');
    const sameName = projects.find((project) => project.name === base);
    if (sameName !== undefined && sameName.repositories.length === 0) {
      const previous = sameName.hasNote ? this.vault.read(sameName.notePath) : undefined;
      this.vault.write(sameName.notePath, renderProjectNote(base, [identity], previous));
      return { project: { ...sameName, repositories: [identity], hasNote: true }, created: false };
    }

    const taken = new Set(projects.map((project) => project.name));
    const name = withCollisionSuffix(base, (candidate) => taken.has(candidate));
    const notePath = projectNotePath(name);
    this.vault.write(notePath, renderProjectNote(name, [identity]));
    return { project: { name, key: slugify(name), repositories: [identity], notePath, hasNote: true }, created: true };
  }
}
