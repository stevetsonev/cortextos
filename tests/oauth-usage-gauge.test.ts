import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkUsageApi } from '../src/bus/oauth.js';

/**
 * Regression tests for the usage gauge.
 *
 * WHY THESE EXIST — 2026-07-30..08-01 the fleet lost ~59h to a weekly quota cap that NO
 * instrument reported. The gauge did not lie loudly; it was silent. Two defects made that
 * possible and both are pinned here:
 *
 *   1. `normalize(undefined)` returned 0, so an unreadable payload became "0% used" —
 *      maximum apparent headroom. The code comment above it already recorded ONE instance of
 *      this (flat-only parsing meeting a nested payload → "100% remaining" while the account
 *      burned). That instance was fixed by adding the nested shape; `undefined → 0` survived,
 *      so the CLASS was still armed for the next shape change.
 *   2. On success the function WRITES utilization into accounts.json, so a silent 0 would be
 *      PERSISTED and `list-oauth-accounts` would then print a confident "0%" instead of
 *      "unknown" — the false-green defeating the gauge built to expose it.
 *
 * The property under test is therefore not "does it parse" but: A MISSING MEASUREMENT MUST BE
 * DISTINGUISHABLE FROM A MEASUREMENT OF ZERO, and must never be persisted as a number.
 */
describe('checkUsageApi — a missing measurement must never read as zero usage', () => {
  const testDir = join(tmpdir(), `cortextos-usage-gauge-${Date.now()}`);
  const accountsPath = join(testDir, 'state', 'oauth', 'accounts.json');
  const realFetch = globalThis.fetch;

  const writeStore = () => {
    mkdirSync(join(testDir, 'state', 'oauth'), { recursive: true });
    writeFileSync(accountsPath, JSON.stringify({
      active: 'default',
      accounts: {
        default: {
          label: 'default',
          access_token: 'test-token-not-a-real-credential',
          refresh_token: 'test-refresh',
          expires_at: Date.now() + 3_600_000,
          last_refreshed: '2026-08-01T00:00:00Z',
          five_hour_utilization: 0.11,
          seven_day_utilization: 0.22,
        },
      },
      rotation_log: [],
    }, null, 1));
  };

  const mockFetch = (status: number, body: unknown) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as typeof fetch;
  };

  beforeEach(() => { mkdirSync(testDir, { recursive: true }); writeStore(); });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const storedUtil = () => {
    const s = JSON.parse(readFileSync(accountsPath, 'utf8'));
    return s.accounts.default;
  };

  it('THROWS on a 200 whose body has no readable utilization fields', async () => {
    mockFetch(200, { some_new_shape: { pct: 42 } });
    await expect(checkUsageApi(testDir, { force: true })).rejects.toThrow(/no readable utilization fields/i);
  });

  it('does NOT persist a 0 when the payload is unreadable — the pre-existing values survive', async () => {
    mockFetch(200, { some_new_shape: { pct: 42 } });
    await expect(checkUsageApi(testDir, { force: true })).rejects.toThrow();
    // The regression: a silent 0 would have been written here and then rendered as "0%".
    expect(storedUtil().five_hour_utilization).toBe(0.11);
    expect(storedUtil().seven_day_utilization).toBe(0.22);
  });

  it('names the keys it DID see, so a shape change is diagnosable without a re-run', async () => {
    mockFetch(200, { five_hour_pct: 90, seven_day_pct: 80 });
    await expect(checkUsageApi(testDir, { force: true }))
      .rejects.toThrow(/five_hour_pct/);
  });

  it('says UNMEASURED rather than low — the distinction the outage turned on', async () => {
    mockFetch(200, {});
    await expect(checkUsageApi(testDir, { force: true })).rejects.toThrow(/UNMEASURED, not low/i);
  });

  // MUST-PASS ARM. Without this the tests above are satisfied by a function that always throws,
  // which would be a differently-broken gauge. A control that can only agree with me is not a control.
  it('still returns real figures from the nested shape, and normalizes 0–100 → 0.0–1.0', async () => {
    mockFetch(200, { five_hour: { utilization: 83 }, seven_day: { utilization: 42 } });
    const r = await checkUsageApi(testDir, { force: true });
    expect(r.five_hour_utilization).toBeCloseTo(0.83, 5);
    expect(r.seven_day_utilization).toBeCloseTo(0.42, 5);
    expect(storedUtil().five_hour_utilization).toBeCloseTo(0.83, 5);
  });

  it('accepts the flat shape too, and a genuine 0 is still a valid READING', async () => {
    // 0 must remain expressible: the fix distinguishes "absent" from "zero", it does not ban zero.
    mockFetch(200, { five_hour_utilization: 0, seven_day_utilization: 0.5 });
    const r = await checkUsageApi(testDir, { force: true });
    expect(r.five_hour_utilization).toBe(0);
    expect(r.seven_day_utilization).toBe(0.5);
  });

  it('classifies 429 as throttling and explicitly disclaims a quota reading', async () => {
    mockFetch(429, { error: { type: 'rate_limit_error' } });
    await expect(checkUsageApi(testDir, { force: true }))
      .rejects.toThrow(/RATE LIMITED[\s\S]*NOT a reading of your quota/);
  });

  it('classifies 403 as a scope problem a refresh cannot fix', async () => {
    mockFetch(403, { error: { type: 'permission_error' } });
    await expect(checkUsageApi(testDir, { force: true }))
      .rejects.toThrow(/FORBIDDEN[\s\S]*refresh will not add it/);
  });

  it('does not write a cache entry when the call fails', async () => {
    mockFetch(429, { error: {} });
    await expect(checkUsageApi(testDir, { force: true })).rejects.toThrow();
    const cache = join(testDir, 'state', 'oauth', 'usage-cache.json');
    expect(existsSync(cache)).toBe(false);
  });
});
