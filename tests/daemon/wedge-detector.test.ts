import { describe, it, expect, vi } from 'vitest';
import {
  classify,
  looksLikeHostSuspend,
  stepAgent,
  resolveThresholds,
  initialWedgeState,
  lastActivityMs,
  type AgentSignals,
  type WedgeActions,
} from '../../src/daemon/wedge-detector.js';

const T = resolveThresholds(undefined); // 15/30/15 min defaults
const MIN = 60_000;
const NOW = 1_000_000_000_000;

function sig(over: Partial<AgentSignals> = {}): AgentSignals {
  return {
    name: 'a', alive: true, isOrchestrator: false,
    jsonlMtimeMs: NOW - 1 * MIN, heartbeatMs: NOW - 1 * MIN, uptimeMs: 3600_000,
    // null = no readable tail ⇒ detectUsageLimit returns not-limited ⇒ the agent
    // stays nominatable. Failing toward "restartable" is deliberate: an unreadable
    // log must never become a standing excuse to skip remediation.
    owesWork: false, stdoutTail: null, ...over,
  };
}

function mockActions() {
  const a: WedgeActions & { probes: any[]; escalations: any[]; logs: any[] } = {
    probes: [], escalations: [], logs: [],
    probe: vi.fn((name: string, msg: string) => { a.probes.push({ name, msg }); return true; }),
    escalate: vi.fn((name: string, toHuman: boolean, detail: string) => { a.escalations.push({ name, toHuman, detail }); }),
    log: vi.fn((event: string, meta: any) => { a.logs.push({ event, meta }); }),
  };
  return a;
}

describe('classify', () => {
  it('dead when not alive', () => {
    expect(classify(sig({ alive: false }), T, NOW)).toBe('dead');
  });
  it('healthy-busy when jsonl advanced recently (mid tool call)', () => {
    expect(classify(sig({ jsonlMtimeMs: NOW - 2 * MIN }), T, NOW)).toBe('healthy-busy');
  });
  it('healthy-idle when quiet but owes NO work (gate-watch guard)', () => {
    expect(classify(sig({ jsonlMtimeMs: NOW - 40 * MIN, owesWork: false }), T, NOW)).toBe('healthy-idle');
  });
  it('healthy-idle when quiet + owes work BUT heartbeat still fresh', () => {
    expect(classify(sig({ jsonlMtimeMs: NOW - 40 * MIN, owesWork: true, heartbeatMs: NOW - 1 * MIN }), T, NOW)).toBe('healthy-idle');
  });
  it('wedge-candidate only when quiet + owes work + heartbeat stale', () => {
    expect(classify(sig({ jsonlMtimeMs: NOW - 40 * MIN, owesWork: true, heartbeatMs: NOW - 40 * MIN }), T, NOW)).toBe('wedge-candidate');
  });
  it('a long healthy tool call (quiet 14m) is NOT a candidate even owing work', () => {
    expect(classify(sig({ jsonlMtimeMs: NOW - 14 * MIN, owesWork: true, heartbeatMs: NOW - 40 * MIN }), T, NOW)).toBe('healthy-busy');
  });
});

describe('looksLikeHostSuspend', () => {
  it('true when ≥2 agents share a near-identical last-activity', () => {
    const a = sig({ name: 'a', jsonlMtimeMs: NOW - 100 * MIN, heartbeatMs: NOW - 100 * MIN });
    const b = sig({ name: 'b', jsonlMtimeMs: NOW - 100 * MIN + 5000, heartbeatMs: NOW - 100 * MIN });
    expect(looksLikeHostSuspend([a, b])).toBe(true);
  });
  it('false when activity timestamps are well spread (both signals)', () => {
    // last-activity = max(jsonl, heartbeat), so spread BOTH — a live heartbeat
    // on either agent legitimately makes it "recently active", not coincident.
    const a = sig({ name: 'a', jsonlMtimeMs: NOW - 100 * MIN, heartbeatMs: NOW - 100 * MIN });
    const b = sig({ name: 'b', jsonlMtimeMs: NOW - 10 * MIN, heartbeatMs: NOW - 10 * MIN });
    expect(looksLikeHostSuspend([a, b])).toBe(false);
  });
});

describe('stepAgent — probe lifecycle', () => {
  const cfg = { enabled: true, max_action: 'escalate' as const };
  const candidate = sig({ jsonlMtimeMs: NOW - 40 * MIN, heartbeatMs: NOW - 40 * MIN, owesWork: true });

  it('candidate + clear → sends a probe, phase→probed', () => {
    const act = mockActions();
    const next = stepAgent(candidate, initialWedgeState(), T, NOW, cfg, act, false);
    expect(act.probes).toHaveLength(1);
    expect(next.phase).toBe('probed');
    expect(next.nudgeCount).toBe(1);
    expect(next.jsonlMtimeAtProbe).toBe(candidate.jsonlMtimeMs);
  });

  it('probed + jsonl advances → cleared (healthy self-clear on tool return)', () => {
    const act = mockActions();
    const probed = { phase: 'probed' as const, probeSentAt: NOW, jsonlMtimeAtProbe: NOW - 40 * MIN, heartbeatAtProbe: NOW - 40 * MIN, nudgeCount: 1 };
    // next tick: jsonl now newer than at-probe
    const s2 = sig({ jsonlMtimeMs: NOW + 1 * MIN, heartbeatMs: NOW - 40 * MIN, owesWork: true });
    const next = stepAgent(s2, probed, T, NOW + 2 * MIN, cfg, act, false);
    expect(next.phase).toBe('clear');
    expect(act.escalations).toHaveLength(0);
  });

  it('probed + unconsumed past grace → confirmed + escalate', () => {
    const act = mockActions();
    const probed = { phase: 'probed' as const, probeSentAt: NOW, jsonlMtimeAtProbe: NOW - 40 * MIN, heartbeatAtProbe: NOW - 40 * MIN, nudgeCount: 2 };
    // grace elapsed, still no jsonl/heartbeat advance
    const later = NOW + 16 * MIN;
    const s2 = sig({ jsonlMtimeMs: NOW - 40 * MIN, heartbeatMs: NOW - 40 * MIN, owesWork: true });
    const next = stepAgent(s2, probed, T, later, cfg, act, false);
    expect(next.phase).toBe('confirmed');
    expect(act.escalations).toHaveLength(1);
    expect(act.escalations[0].detail).toMatch(/bypass-dialog/i); // carries the recovery caveat
  });

  it('orchestrator wedge escalates DIRECT to human', () => {
    const act = mockActions();
    const probed = { phase: 'probed' as const, probeSentAt: NOW, jsonlMtimeAtProbe: NOW - 40 * MIN, heartbeatAtProbe: NOW - 40 * MIN, nudgeCount: 2 };
    const s2 = sig({ isOrchestrator: true, jsonlMtimeMs: NOW - 40 * MIN, heartbeatMs: NOW - 40 * MIN, owesWork: true });
    const next = stepAgent(s2, probed, T, NOW + 16 * MIN, cfg, act, false);
    expect(next.phase).toBe('confirmed');
    expect(act.escalations[0].toHuman).toBe(true);
  });

  it('host-suspend suppresses remediation (no probe, no escalate)', () => {
    const act = mockActions();
    const next = stepAgent(candidate, initialWedgeState(), T, NOW, cfg, act, /*suppress*/ true);
    expect(act.probes).toHaveLength(0);
    expect(act.escalations).toHaveLength(0);
    expect(next.phase).toBe('clear');
  });

  it('max_action=observe never probes (detect+log only)', () => {
    const act = mockActions();
    const next = stepAgent(candidate, initialWedgeState(), T, NOW, { enabled: true, max_action: 'observe' }, act, false);
    expect(act.probes).toHaveLength(0);
    expect(next.phase).toBe('clear');
    expect(act.logs.some((l) => l.event === 'wedge_candidate_observed')).toBe(true);
  });

  it('healthy-idle candidate that clears its queue resets an in-flight probe', () => {
    const act = mockActions();
    const probed = { phase: 'probed' as const, probeSentAt: NOW, jsonlMtimeAtProbe: NOW - 40 * MIN, heartbeatAtProbe: NOW - 40 * MIN, nudgeCount: 1 };
    const s2 = sig({ jsonlMtimeMs: NOW - 40 * MIN, heartbeatMs: NOW - 40 * MIN, owesWork: false }); // queue cleared
    const next = stepAgent(s2, probed, T, NOW + 2 * MIN, cfg, act, false);
    expect(next.phase).toBe('clear');
  });
});

describe('lastActivityMs', () => {
  it('takes the max of jsonl and heartbeat', () => {
    expect(lastActivityMs(sig({ jsonlMtimeMs: 100, heartbeatMs: 200 }))).toBe(200);
    expect(lastActivityMs(sig({ jsonlMtimeMs: 500, heartbeatMs: null }))).toBe(500);
  });
});
