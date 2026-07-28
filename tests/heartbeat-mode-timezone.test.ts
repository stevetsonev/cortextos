import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { detectDayNightMode, updateHeartbeat } from '../src/bus/heartbeat.js';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Heartbeat `mode` was computed in UTC because src/cli/bus.ts passed `opts.timezone`
 * — the --timezone CLI flag, which nobody passes — so heartbeat.ts fell back to
 * detectDayNightMode('UTC'). Found by jordan-blake 2026-07-28.
 *
 * The instant below is the one that exposed it: 23:00Z is 17:00 in America/Edmonton.
 * Locally that is the middle of the working day; in UTC it is night. Every agent's
 * SOUL.md carries "Night Mode: no Telegram messages unless critical", so the shifted
 * window covers 08:00-16:00 of the user's actual day.
 */
const AT_2300Z = new Date('2026-07-28T23:00:00.000Z'); // 17:00 MDT — day locally, night in UTC

describe('detectDayNightMode — the 6h shift', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(AT_2300Z); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports DAY for the org timezone at 17:00 local', () => {
    expect(detectDayNightMode('America/Edmonton')).toBe('day');
  });

  it('reports NIGHT for the same instant in UTC — this is the defect', () => {
    expect(detectDayNightMode('UTC')).toBe('night');
  });

  it('the two disagree, which is what made every agent look nocturnal at 5pm', () => {
    expect(detectDayNightMode('America/Edmonton')).not.toBe(detectDayNightMode('UTC'));
  });
});

describe('detectDayNightMode — boundaries in the org timezone', () => {
  afterEach(() => { vi.useRealTimers(); });

  // 08:00 and 22:00 MDT (UTC-6) are 14:00Z and 04:00Z(+1d).
  it.each([
    ['07:59 MDT', '2026-07-28T13:59:00.000Z', 'night'],
    ['08:00 MDT', '2026-07-28T14:00:00.000Z', 'day'],
    ['21:59 MDT', '2026-07-29T03:59:00.000Z', 'day'],
    ['22:00 MDT', '2026-07-29T04:00:00.000Z', 'night'],
  ])('%s -> %s', (_label, iso, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
    expect(detectDayNightMode('America/Edmonton')).toBe(expected);
  });

  it('falls back to UTC for an unusable timezone rather than throwing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(AT_2300Z);
    expect(['day', 'night']).toContain(detectDayNightMode('Not/AZone'));
  });
});

describe('updateHeartbeat writes the mode it was given a timezone for', () => {
  let dir: string;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(AT_2300Z);
    dir = join(tmpdir(), `hb-mode-${process.pid}-${Math.round(AT_2300Z.getTime())}`);
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

  const read = () => {
    const f = join(dir, 'heartbeat.json');
    expect(existsSync(f)).toBe(true);
    return JSON.parse(readFileSync(f, 'utf8'));
  };

  it('records DAY when the resolved org timezone is passed through', () => {
    updateHeartbeat({ stateDir: dir } as never, 'probe-agent', 'online', {
      org: 'finngo', timezone: 'America/Edmonton',
    });
    expect(read().mode).toBe('day');
  });

  it('records NIGHT when timezone is omitted — the pre-fix behaviour, pinned so a regression is visible', () => {
    updateHeartbeat({ stateDir: dir } as never, 'probe-agent', 'online', { org: 'finngo' });
    expect(read().mode).toBe('night');
  });
});
