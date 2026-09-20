export const READ = 0o4;
export const WRITE = 0o2;
export const EXECUTE = 0o1;

export interface OwnershipInfo {
  uid: number;
  gid: number;
  mode: number;
}

export function permissionBits(info: OwnershipInfo, uid: number, gid: number): number {
  if (info.uid === uid) return (info.mode >> 6) & 0o7;
  if (info.gid === gid) return (info.mode >> 3) & 0o7;
  return info.mode & 0o7;
}

export function hasPermission(info: OwnershipInfo, uid: number, gid: number, mask: number): boolean {
  return (permissionBits(info, uid, gid) & mask) === mask;
}
