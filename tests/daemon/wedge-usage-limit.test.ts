/**
 * §5d/§5e acceptance tests for the usage-limit exclusion branch.
 *
 * Ported as-is from jordan-blake's spec v3
 * (deliverables/jordan-blake/task_1784967282443_81148263/
 *  wedge-detection-thresholds-v3-2026-07-29.md), which executed every pattern
 * against real text before shipping. Both prior versions of §5 were
 * pattern-vs-real-text failures that survived review because nobody ever ran the
 * pattern against text — so these arms are the deliverable, not a formality.
 *
 * 🔴 BOTH ARMS OR NEITHER. v1 (too narrow) would have PASSED must-reject alone;
 * v2 (too broad) would have PASSED must-admit alone. A single arm certifies the
 * exact defect it was built to catch.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  detectUsageLimit,
  classify,
  stepAgent,
  resolveThresholds,
  initialWedgeState,
  type AgentSignals,
  type WedgeActions,
} from '../../src/daemon/wedge-detector.js';

const T = resolveThresholds(undefined);
const MIN = 60_000;
const NOW = 1_000_000_000_000;

/** A signal set that is wedge-candidate-shaped: quiet, owes work, heartbeat stale. */
function limitedShape(over: Partial<AgentSignals> = {}): AgentSignals {
  return {
    name: 'a', alive: true, isOrchestrator: false,
    jsonlMtimeMs: NOW - 60 * MIN, heartbeatMs: NOW - 60 * MIN, uptimeMs: 3600_000,
    owesWork: true, stdoutTail: null, ...over,
  };
}

function mockActions(): WedgeActions & { logs: Array<[string, Record<string, unknown>]> } {
  const logs: Array<[string, Record<string, unknown>]> = [];
  return {
    logs,
    probe: vi.fn(() => true),
    escalate: vi.fn(),
    log: (event, meta) => { logs.push([event, meta]); },
  };
}

// ── §5e MUST-ADMIT ─────────────────────────────────────────────────────────────
// Three real limit lines covering BOTH timezone shapes. v1 anchored on
// `(America/` and missed the two `(UTC)` variants — reset boundaries are not a
// fleet constant.
const REAL_LIMIT_LINES = [
  'Claude usage limit reached · resets 2am (America/Edmonton)',
  'You have hit your weekly limit · resets 4am (UTC)',
  '5-hour limit reached · resets 8am (UTC)',
];

describe('§5a detection — MUST-ADMIT arm', () => {
  it.each(REAL_LIMIT_LINES)('classifies as usage-limited: %s', (line) => {
    expect(detectUsageLimit(line).limited).toBe(true);
  });

  it('admits regardless of case and ANSI colour codes', () => {
    const noisy = '\x1b[31mClaude USAGE LIMIT reached\x1b[0m · resets 2am (UTC)';
    expect(detectUsageLimit(noisy).limited).toBe(true);
  });
});

// ── §5e MUST-REJECT ────────────────────────────────────────────────────────────
describe('§5a detection — MUST-REJECT arm', () => {
  // Arm (a): the PROSE of the detector's own source — the exact text that broke
  // v2, whose `resets .*` alternative matched the line
  // "Any sign of life or a cleared queue resets an in-flight probe."
  //
  // 🔴 SUBJECT NARROWED FROM THE SPEC, AND THE REASON IS THE INTERESTING PART.
  // v3 §5e specifies the subject as the WHOLE FILE, reasoning that it "stays a
  // valid regression input as long as line 146 exists". That was true when it was
  // written and the FIX ITSELF INVALIDATED IT: implementing §5a puts the literal
  // markers ('usage limit', 'quota exceeded', …) into this very file, so the
  // detector's own source is now the ONE file that can NEVER pass its own
  // must-reject arm. Measured, not predicted — the whole-file version failed on
  // first run against a correct implementation.
  // ⇒ Same family as fixing the last divergent row and destroying the reproducer:
  //   an acceptance subject chosen before the fix can be consumed BY the fix.
  //   Scoped to the prose lines, which is what the arm was actually testing.
  it('(a) rejects the detector prose that defeated v2', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/daemon/wedge-detector.ts'), 'utf-8',
    );
    const proseLines = src
      .split('\n')
      .filter((l) => /\bresets?\b/.test(l) && !l.includes("'"))
      .join('\n');

    // Positive control: the subject really is what we think it is. Without this,
    // an empty or over-filtered selection passes the arm by matching nothing —
    // a clean zero from a query that can never fire.
    expect(proseLines).toContain('resets an in-flight probe');
    expect(detectUsageLimit(proseLines).limited).toBe(false);
  });

  // The whole-file case is still worth pinning — as the OPPOSITE expectation, so
  // nobody "fixes" it back to the spec's version and reintroduces a red suite.
  it('(a-note) the full source DOES contain markers, by construction', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/daemon/wedge-detector.ts'), 'utf-8',
    );
    expect(src).toContain('usage limit'); // the declaration itself
    expect(detectUsageLimit(src).limited).toBe(true);
  });

  it('(b) rejects a healthy agent tail', () => {
    const healthy = [
      'cron fired: heartbeat',
      'Updated heartbeat: sam-rivera',
      'a cleared queue resets an in-flight probe',
      'reset the counter',
    ].join('\n');
    expect(detectUsageLimit(healthy).limited).toBe(false);
  });

  // The transient family is DELIBERATELY excluded: seconds-to-minutes events do
  // not account for a multi-hour silence, and admitting them would exclude a
  // genuinely wedged agent from restart forever.
  it.each([
    'rate_limit_error',
    'rate limit exceeded, retrying',
    'rate-limit hit',
    'too many requests',
    'overloaded_error',
  ])('rejects the transient marker: %s', (line) => {
    expect(detectUsageLimit(line).limited).toBe(false);
  });
});

// ── §5b extraction ─────────────────────────────────────────────────────────────
describe('§5b extraction — only after §5a fires', () => {
  it('parses a free-form reset clause in any timezone', () => {
    expect(detectUsageLimit(REAL_LIMIT_LINES[0]!).resetsAt).toBe('2am (america/edmonton)');
    expect(detectUsageLimit(REAL_LIMIT_LINES[1]!).resetsAt).toBe('4am (utc)');
  });

  it('🔴 a parse failure stays LIMITED with an unknown ETA — never falls through', () => {
    const v = detectUsageLimit('Claude usage limit reached');
    expect(v.limited).toBe(true);   // the classification must survive...
    expect(v.resetsAt).toBeNull();  // ...even with no ETA to report
  });

  it('does not borrow a reset clause from an unrelated line', () => {
    const tail = 'a cleared queue resets an in-flight probe\nquota exceeded';
    const v = detectUsageLimit(tail);
    expect(v.limited).toBe(true);
    expect(v.resetsAt).toBeNull(); // the MATCHED line carries no reset clause
  });
});

// ── §5c actions ────────────────────────────────────────────────────────────────
describe('§5c — a usage-limited agent is never probed and never restarted', () => {
  it('classifies wedge-candidate shape as usage-limited when the tail says so', () => {
    const s = limitedShape({ stdoutTail: REAL_LIMIT_LINES[1] });
    expect(classify(s, T, NOW)).toBe('usage-limited');
    // Control: the SAME signals without the marker are still a wedge candidate,
    // so the reclassification is caused by the tail and nothing else.
    expect(classify(limitedShape(), T, NOW)).toBe('wedge-candidate');
  });

  it('never probes, and drops any in-flight probe state', () => {
    const a = mockActions();
    const s = limitedShape({ stdoutTail: REAL_LIMIT_LINES[0] });
    const prev = { phase: 'probed' as const, probeSentAt: NOW - 60 * MIN, nudgeCount: 1 };
    const next = stepAgent(s, prev, T, NOW, { enabled: true, max_action: 'escalate' }, a, false);

    expect(a.probe).not.toHaveBeenCalled();
    expect(next.phase).toBe('clear');       // cannot age into 'confirmed'
    expect(next.nudgeCount).toBe(0);
    expect(a.logs.map(([e]) => e)).toContain('wedge_usage_limited');
  });

  it('escalates as quota-blocked, explicitly stating no restart was performed', () => {
    const a = mockActions();
    const s = limitedShape({ stdoutTail: REAL_LIMIT_LINES[2] });
    stepAgent(s, initialWedgeState(), T, NOW, { enabled: true, max_action: 'escalate' }, a, false);

    const detail = (a.escalate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![2] as string;
    expect(detail).toContain('USAGE-LIMITED');
    expect(detail).toContain('NO restart performed');
  });

  it('reports an unknown ETA rather than downgrading the classification', () => {
    const a = mockActions();
    const s = limitedShape({ stdoutTail: 'Claude usage limit reached' }); // no reset clause
    const next = stepAgent(s, initialWedgeState(), T, NOW, { enabled: true, max_action: 'escalate' }, a, false);

    const meta = a.logs.find(([e]) => e === 'wedge_usage_limited')![1];
    expect(meta.resetsAt).toBe('unknown');
    expect(next.phase).toBe('clear');
    expect(a.probe).not.toHaveBeenCalled();
  });

  it('🔴 an unreadable tail does NOT suppress remediation (fails toward restartable)', () => {
    const s = limitedShape({ stdoutTail: null });
    expect(classify(s, T, NOW)).toBe('wedge-candidate');
  });
});
