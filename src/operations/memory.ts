import { readFileSync } from 'node:fs';

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function rssFromStatus(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const match = /^VmRSS:\s+([0-9]+)\s+kB$/m.exec(text);
  if (match === null) return undefined;
  return Number(match[1]) * 1024;
}

export function containerRssBytes(): number | undefined {
  const cgroup = readText('/sys/fs/cgroup/memory.current');
  if (cgroup !== undefined) {
    const value = Number(cgroup.trim());
    if (Number.isInteger(value) && value > 0) return value;
  }
  return rssFromStatus(readText('/proc/self/status'));
}

export function processRssBytes(pid: number | undefined): number | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
  return rssFromStatus(readText(`/proc/${pid}/status`));
}
