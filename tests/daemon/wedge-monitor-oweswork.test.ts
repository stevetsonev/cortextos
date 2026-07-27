/**
 * owesWork() — the wedge detector's false-positive guard.
 *
 * WHY THIS FILE EXISTS. Before it, `tests/daemon/wedge-detector.test.ts` covered the pure
 * decision core and NOTHING imported `wedge-monitor.ts` — the half that actually reads disk.
 * Every existing test supplies `owesWork` as a boolean INPUT to `classify()`, so the suite
 * passed identically whether `owesWork()` read `assignee` or `assigned_to`. The field-name
 * defect fixed in 5fa8e30 was invisible to the whole suite BY CONSTRUCTION, and 5fa8e30
 * shipped no test of its own.
 *
 * These tests use REAL JSON files in a temp dir — no fs mocking — so they exercise the same
 * readdirSync/readFileSync path the daemon runs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { owesWork } from '../../src/daemon/wedge-monitor.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_785_134_000_000; // fixed clock; no Date.now() in assertions

let root: string;
let taskDir: string;
let inboxDir: string;

/** Write a task record. Field names are the caller's problem on purpose — that IS the subject. */
function task(name: string, fields: Record<string, unknown>): void {
  writeFileSync(join(taskDir, `${name}.json`), JSON.stringify(fields));
}

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wedge-oweswork-'));
  taskDir = join(root, 'tasks');
  inboxDir = join(root, 'inbox');
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(inboxDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('owesWork — the field the task store actually writes', () => {
  /**
   * 🔴 THE REGRESSION ARM. This is the one that fails if `?? t.assigned_to` is ever removed.
   * Measured 2026-07-27: `assigned_to` on 346 of 346 task records, `assignee` on ZERO.
   * The CLI flag that creates a task is `--assignee`, which is what taught the wrong name.
   */
  it('fires on assigned_to — the name 346/346 live records use', () => {
    task('t1', { status: 'in_progress', assigned_to: 'jordan-blake', updated_at: iso(NOW - 3 * HOUR) });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });

  it('still honours the legacy assignee name', () => {
    task('t1', { status: 'in_progress', assignee: 'jordan-blake', updated_at: iso(NOW - 3 * HOUR) });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });

  it('still honours the legacy agent name', () => {
    task('t1', { status: 'in_progress', agent: 'jordan-blake', updated_at: iso(NOW - 3 * HOUR) });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });

  /**
   * 🔴 INCIDENT REPLAY — the exact state observed in production on 2026-07-27 06:38Z.
   * The running daemon (pid 1232, started 07-22, predating the fix) held this and wrote
   * {"phase":"clear","nudgeCount":0} to wedge-state.json: a stale in-progress task with a
   * DRAINED inbox is precisely the scenario the detector exists for, and it read healthy.
   * If this arm ever goes green-by-accident, the guard is half-dead again.
   */
  it('fires on a stale assigned_to task even with a completely empty inbox', () => {
    task('task_1784967282443_81148263', {
      status: 'in_progress',
      assigned_to: 'jordan-blake',
      updated_at: iso(NOW - 3.7 * HOUR),
    });
    // inbox deliberately left empty — with the defect present, this returned false
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });
});

describe('owesWork — cases that must NOT fire', () => {
  it('is false with no tasks and an empty inbox (control)', () => {
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(false);
  });

  it('does not fire on another agent stale task', () => {
    task('t1', { status: 'in_progress', assigned_to: 'morgan-quinn', updated_at: iso(NOW - 9 * HOUR) });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(false);
  });

  it('does not fire on a task updated within the 2h floor', () => {
    task('t1', { status: 'in_progress', assigned_to: 'jordan-blake', updated_at: iso(NOW - 1 * HOUR) });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(false);
  });

  it('does not fire on a completed task however stale', () => {
    task('t1', { status: 'completed', assigned_to: 'jordan-blake', updated_at: iso(NOW - 400 * HOUR) });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(false);
  });

  it('ignores non-json files and survives malformed json', () => {
    writeFileSync(join(taskDir, 'notes.txt'), 'not a task');
    writeFileSync(join(taskDir, 'broken.json'), '{ this is not json');
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(false);
  });
});

describe('owesWork — the inbox half', () => {
  it('fires on a non-empty inbox with no tasks at all', () => {
    writeFileSync(join(inboxDir, 'msg1.json'), JSON.stringify({ from: 'morgan-quinn' }));
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });

  it('is false when the inbox holds only non-json files', () => {
    writeFileSync(join(inboxDir, '.dedup-hashes'), 'x');
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(false);
  });

  it('is false when the inbox directory does not exist', () => {
    expect(owesWork(taskDir, join(root, 'no-such-inbox'), 'jordan-blake', NOW)).toBe(false);
  });
});

/**
 * A missing updated_at must count as stale rather than silently clearing the guard —
 * `Number.isFinite(updated)` false ⇒ true. Pinned because the tempting "tidy" fix
 * (default a missing timestamp to now) would disable the guard for records that lack it.
 */
describe('owesWork — missing timestamp fails toward DETECTION', () => {
  // These use `assignee` deliberately so they isolate TIMESTAMP handling. With `assigned_to`
  // they would also go red on a field-name regression, making the failure ambiguous — the
  // field name has its own dedicated arms above.
  it('treats an absent updated_at as stale', () => {
    task('t1', { status: 'in_progress', assignee: 'jordan-blake' });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });

  it('treats an unparseable updated_at as stale', () => {
    task('t1', { status: 'in_progress', assignee: 'jordan-blake', updated_at: 'not-a-date' });
    expect(owesWork(taskDir, inboxDir, 'jordan-blake', NOW)).toBe(true);
  });
});
