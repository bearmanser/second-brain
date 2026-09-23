import { BrainError } from '../contracts/errors.js';

export interface Project {
  id: string;
  display_name: string;
  relative_root: string;
  repository_identity?: string;
}

export type ProjectFilter =
  | { mode: 'all' }
  | { mode: 'project'; identifier: string };

export interface ProjectRegistryPort {
  all(): Project[];
  get(identifier: string): Project | undefined;
}

export interface ProjectAlias {
  identifier: string;
  project_id: string;
}

export const PROJECT_IDENTIFIER_MAX_LENGTH = 256;
export const PROJECT_DISPLAY_NAME_MAX_LENGTH = 200;
export const PROJECT_RELATIVE_ROOT_MAX_LENGTH = 512;

const CONTROL_OR_NULL = /[\u0000-\u001f\u007f]/;
const PATH_TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;
const IDENTIFIER_ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function invalidInput(message: string): BrainError {
  return new BrainError({ code: 'INVALID_INPUT', message });
}

function conflict(message: string): BrainError {
  return new BrainError({ code: 'CONFLICT', message });
}

export function isProjectIdentifier(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > PROJECT_IDENTIFIER_MAX_LENGTH) return false;
  if (CONTROL_OR_NULL.test(value) || value.includes('\\')) return false;
  if (PATH_TRAVERSAL.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('.')) return false;
  return IDENTIFIER_ALLOWED.test(value);
}

export function assertProjectIdentifier(value: string): string {
  if (typeof value !== 'string') {
    throw invalidInput('a project identifier must be a string');
  }
  if (value !== value.trim()) {
    throw invalidInput('a project identifier must not have surrounding whitespace');
  }
  if (!isProjectIdentifier(value)) {
    throw invalidInput('a project identifier is malformed');
  }
  return value;
}

function assertDisplayName(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > PROJECT_DISPLAY_NAME_MAX_LENGTH ||
    CONTROL_OR_NULL.test(value)
  ) {
    throw invalidInput('a project display name is malformed');
  }
  return value;
}

function assertRelativeRoot(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > PROJECT_RELATIVE_ROOT_MAX_LENGTH ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    CONTROL_OR_NULL.test(value) ||
    PATH_TRAVERSAL.test(value)
  ) {
    throw invalidInput('a project relative root is malformed');
  }
  const segments = value.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment.startsWith('.'))) {
    throw invalidInput('a project relative root is malformed');
  }
  return value;
}

export function projectFilter(input: { project?: string; scope?: string }): ProjectFilter {
  const present: string[] = [];
  if (input.project !== undefined) present.push(input.project);
  if (input.scope !== undefined) present.push(input.scope);
  if (present.length === 0) return { mode: 'all' };
  const validated = present.map((value) => assertProjectIdentifier(value));
  if (validated.length === 1 || validated[0] === validated[1]) {
    return { mode: 'project', identifier: validated[0] };
  }
  throw invalidInput('project and scope refer to different projects');
}

export function requiredProject(input: { project?: string; scope?: string }): string {
  const filter = projectFilter(input);
  if (filter.mode === 'all') {
    throw new BrainError({ code: 'SCOPE_REQUIRED', message: 'a destination project is required' });
  }
  return filter.identifier;
}

export class ProjectRegistry implements ProjectRegistryPort {
  private readonly projects = new Map<string, Project>();
  private readonly order: string[] = [];
  private readonly identifiers = new Map<string, string>();
  private readonly roots = new Map<string, string>();
  private readonly unusable = new Set<string>();

  constructor(
    projects: readonly Project[],
    aliases: readonly ProjectAlias[] = [],
    unusable: readonly string[] = []
  ) {
    for (const project of projects) this.registerProject(project);
    for (const alias of aliases) this.registerAlias(alias);
    for (const id of unusable) {
      const canonical = this.identifiers.get(id) ?? id;
      if (!this.projects.has(canonical)) {
        throw invalidInput('an unusable project must be a known project');
      }
      this.unusable.add(canonical);
    }
  }

  all(): Project[] {
    return this.order
      .filter((id) => !this.unusable.has(id))
      .map((id) => ({ ...(this.projects.get(id) as Project) }));
  }

  get(identifier: string): Project | undefined {
    const key = assertProjectIdentifier(identifier);
    const id = this.identifiers.get(key) ?? key;
    const project = this.projects.get(id);
    return project === undefined ? undefined : { ...project };
  }

  isUsable(identifier: string): boolean {
    const project = this.get(identifier);
    return project !== undefined && !this.unusable.has(project.id);
  }

  unusableProjects(): Project[] {
    return this.order
      .filter((id) => this.unusable.has(id))
      .map((id) => ({ ...(this.projects.get(id) as Project) }));
  }

  private registerProject(project: Project): void {
    const id = assertProjectIdentifier(project.id);
    const displayName = assertDisplayName(project.display_name);
    const relativeRoot = assertRelativeRoot(project.relative_root);
    const repositoryIdentity =
      project.repository_identity === undefined
        ? undefined
        : assertProjectIdentifier(project.repository_identity);
    const existing = this.projects.get(id);
    if (existing !== undefined) {
      if (
        existing.display_name !== displayName ||
        existing.relative_root !== relativeRoot ||
        existing.repository_identity !== repositoryIdentity
      ) {
        throw conflict(`project ${id} is already registered with different metadata`);
      }
      return;
    }
    const rootOwner = this.roots.get(relativeRoot);
    if (rootOwner !== undefined && rootOwner !== id) {
      throw conflict(`project root ${relativeRoot} is already registered to another project`);
    }
    const stored: Project = {
      id,
      display_name: displayName,
      relative_root: relativeRoot,
      ...(repositoryIdentity === undefined ? {} : { repository_identity: repositoryIdentity })
    };
    this.projects.set(id, stored);
    this.order.push(id);
    this.roots.set(relativeRoot, id);
    this.registerIdentifier(id, id);
    if (repositoryIdentity !== undefined && repositoryIdentity !== id) {
      this.registerIdentifier(repositoryIdentity, id);
    }
  }

  private registerAlias(alias: ProjectAlias): void {
    const identifier = assertProjectIdentifier(alias.identifier);
    if (!this.projects.has(alias.project_id)) {
      throw invalidInput(`alias ${identifier} names an unknown project`);
    }
    this.registerIdentifier(identifier, alias.project_id);
  }

  private registerIdentifier(identifier: string, projectId: string): void {
    const existing = this.identifiers.get(identifier);
    if (existing !== undefined && existing !== projectId) {
      throw conflict(`identifier ${identifier} already names a different project`);
    }
    this.identifiers.set(identifier, projectId);
  }
}
