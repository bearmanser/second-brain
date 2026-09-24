import { NOTE_EXTENSION, safeNoteFilename } from '../notes/paths.js';

export function projectHubPath(projectRoot: string): string {
  const leaf = projectRoot.slice(projectRoot.lastIndexOf('/') + 1);
  return `${projectRoot}/${safeNoteFilename(leaf)}`;
}

export function projectProperty(projectRoot: string): string {
  const path = projectHubPath(projectRoot);
  return `[[${path.slice(0, path.length - NOTE_EXTENSION.length)}]]`;
}
