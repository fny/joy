import { test, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { acquireSingleton, SingletonError } from "./singleton";

function tmpLock(): string {
  return join(mkdtempSync(join(tmpdir(), "joy-singleton-")), "daemon.lock");
}

test("acquires when no lock exists and writes our pid", () => {
  const lock = tmpLock();
  const release = acquireSingleton(lock);
  expect(existsSync(lock)).toBe(true);
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(process.pid);
  release();
  expect(existsSync(lock)).toBe(false);
});

test("throws SingletonError when a live process holds the lock", () => {
  const lock = tmpLock();
  writeFileSync(lock, "99999");
  expect(() => acquireSingleton(lock, { isAlive: () => true })).toThrow(SingletonError);
  expect(existsSync(lock)).toBe(true); // not removed — the holder keeps it
});

test("reclaims a stale lock left by a dead process", () => {
  const lock = tmpLock();
  writeFileSync(lock, "99999");
  const release = acquireSingleton(lock, { isAlive: () => false });
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(process.pid);
  release();
  expect(existsSync(lock)).toBe(false);
});

test("release() only unlinks the lock if we still hold it", () => {
  const lock = tmpLock();
  const release = acquireSingleton(lock);
  writeFileSync(lock, "12345"); // someone else took it over
  release();
  expect(existsSync(lock)).toBe(true);
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(12345);
});
