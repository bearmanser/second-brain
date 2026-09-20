import { expect, test } from 'vitest';
import { EXECUTE, READ, WRITE, hasPermission, permissionBits } from '../../src/operations/permissions.js';

const RWX = READ | WRITE | EXECUTE;

test('a target-uid-owned mode 0007 directory is denied to its owner', () => {
  const info = { uid: 1000, gid: 1000, mode: 0o0007 };
  expect(permissionBits(info, 1000, 2000)).toBe(0);
  expect(hasPermission(info, 1000, 2000, READ)).toBe(false);
  expect(hasPermission(info, 1000, 2000, RWX)).toBe(false);
});

test('a matching owner class is evaluated only against owner bits', () => {
  const info = { uid: 1000, gid: 1000, mode: 0o0407 };
  expect(permissionBits(info, 1000, 1000)).toBe(READ);
  expect(hasPermission(info, 1000, 1000, READ)).toBe(true);
  expect(hasPermission(info, 1000, 1000, WRITE)).toBe(false);
  expect(hasPermission(info, 1000, 1000, RWX)).toBe(false);
});

test('a matching group class is evaluated only against group bits', () => {
  const info = { uid: 1000, gid: 1000, mode: 0o0070 };
  expect(permissionBits(info, 999, 1000)).toBe(RWX);
  expect(hasPermission(info, 999, 1000, RWX)).toBe(true);
  expect(hasPermission(info, 999, 2000, READ)).toBe(false);
});

test('a non-matching uid and gid fall through to the other class only', () => {
  const info = { uid: 1000, gid: 1000, mode: 0o0077 };
  expect(permissionBits(info, 2000, 3000)).toBe(RWX & 0o7);
  expect(hasPermission(info, 2000, 3000, RWX)).toBe(true);

  const restrictive = { uid: 1000, gid: 1000, mode: 0o0770 };
  expect(hasPermission(restrictive, 2000, 3000, READ)).toBe(false);
});

test('mixed classes require the full mask in the selected class', () => {
  const info = { uid: 1000, gid: 1000, mode: 0o0754 };
  expect(hasPermission(info, 1000, 3000, RWX)).toBe(true);
  expect(hasPermission(info, 2000, 1000, READ | EXECUTE)).toBe(true);
  expect(hasPermission(info, 2000, 1000, READ)).toBe(true);
  expect(hasPermission(info, 2000, 1000, WRITE)).toBe(false);
  expect(hasPermission(info, 3000, 4000, READ)).toBe(true);
  expect(hasPermission(info, 3000, 4000, WRITE)).toBe(false);
});
