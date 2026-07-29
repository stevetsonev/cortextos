/**
 * Wedge detection — detects an agent that is ALIVE but NOT PROGRESSING (stuck
 * mid-turn / frozen PTY) and distinguishes it from healthy-busy, healthy-idle,
 * and dead. Design + validation: outputs/cortextos/wedge-detection-spec.md
 * (validated end-to-end against a real orchestrator wedge, 2026-07-14).
 *
 * Two-stage detection (the core insight, learned the hard way):
 *   Stage 1 — cheap PASSIVE pre-filter over on-disk signals (jsonl mtime, bus
 *     task/inbox/cron state, heartbeat). Narrows WHO to probe. Passive signals
 *     alone CANNOT separate healthy-busy (mid long tool call → also quiet) from
 *     wedged, so the pre-filter only nominates candidates.
 *   Stage 2 — the DISCRIMINATOR is an inject-probe: nudge the candidate; if it
 *     CONSUMES the probe (jsonl advances / heartbeat refreshes) it's healthy
 *     (a busy agent self-clears when its tool call returns); if the probe is
 *     unconsumed past a grace window, it's wedged.
 *
 * NOTE: "active child process under the PTY" is NOT a signal — it's a constant
 * (the claude wrapper always has MCP-server children whether healthy or wedged).
 *
 * This module is PURE + dependency-injected: no fs / process / timers here.
 * The daemon (agent-manager) supplies signal snapshots + an actions interface
 * and persists the returned state. That keeps the decision logic unit-testable.
 */
import type { WedgeDetectionConfig } from '../types/index.js';

/** On-disk signal snapshot for one agent at tick time (all epoch ms / bool). */
export interface AgentSignals {
  name: string;
  /** Daemon-reported liveness: is the PTY process up + continuing? */
  alive: boolean;
  /** Is this agent the org orchestrator? (orchestrator wedge escalates direct-to-human.) */
  isOrchestrator: boolean;
  /** Newest conversation .jsonl mtime, or null if none/unreadable. */
  jsonlMtimeMs: number | null;
  /** last_heartbeat epoch ms, or null. */
  heartbeatMs: number | null;
  /** Process uptime ms (for crash-loop detection at the restart tier — informational here). */
  uptimeMs: number;
  /**
   * Does the agent owe work? in_progress task not updated >2h, un-ACK'd inbox
   * past redelivery, OR a fired cron with NO logged handling (event OR memory
   * write) in the window. The false-positive guard for correctly-idle agents.
   */
  owesWork: boolean;
  /**
   * Tail of the agent's stdout log (~last 200 lines), or null if unreadable.
   *
   * 🔴 THE DISCRIMINATOR IS CONTENT, NOT MTIME. A quota-blocked session is
   * indistinguishable from a wedged one on every signal above — alive, quiet
   * jsonl, stale heartbeat, owes work. Only the text separates them.
   * (Also the 2026-06-13 fable-5 lesson: a broken agent that wrote error text on
   * every cron fire made mtime read as "active".)
   */
  stdoutTail: string | null;
}

/**
 * §5a DETECTION — blocking-quota phrasing ONLY.
 *
 * Lifted verbatim from `src/hooks/hook-crash-alert.ts:69-73`, which is already in
 * production use for crash alerting and is correctly NOT timezone-anchored.
 * Reused rather than re-derived.
 *
 * ⚠️ DELIBERATELY EXCLUDED — `hook-crash-alert.ts:64-68` (`overloaded_error`,
 * `rate_limit_error`, `rate limit`, `rate-limit`, `too many requests`). Those are
 * TRANSIENT (seconds-to-minutes) and DO NOT ACCOUNT FOR A MULTI-HOUR SILENCE.
 * Admitting them re-opens the false-positive by another door: a genuinely wedged
 * agent whose tail happens to carry an hours-old transient rate-limit line would
 * be excluded from restart forever. The exclusion must only admit states that
 * actually explain the observed silence.
 *
 * ⚠️ DO NOT anchor on a timezone. `resets 4am (UTC)`, `resets 8am (UTC)` and
 * `resets 2am (America/Edmonton)` are all real and observed on different agents —
 * reset boundaries are NOT a fleet constant. (v1's defect: false negative, which
 * restarts a limited agent into its own quota.)
 *
 * ⚠️ DO NOT admit a bare `resets` / `reset` term. It is prose, not a signature —
 * it matches this very file's line "a cleared queue resets an in-flight probe".
 * (v2's defect: false positive, which suppresses the restart of a real wedge
 * forever, behind a plausible status nobody chases.)
 */
const USAGE_LIMIT_MARKERS = [
  'usage limit',
  'weekly limit',
  '5-hour limit',
  '5h limit',
  'quota exceeded',
] as const;

/** Normalise a captured tail the same way hook-crash-alert.ts:62 does. */
function normaliseTail(tail: string): string {
  // eslint-disable-next-line no-control-regex
  return tail.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
}

/** Result of the §5a/§5b split: detection first, extraction only after it fires. */
export interface UsageLimitVerdict {
  limited: boolean;
  /**
   * §5b — reset clause parsed from the MATCHED line, free-form, any timezone.
   * `null` when absent or unparseable.
   *
   * 🔴 A PARSE FAILURE MUST NEVER FALL THROUGH TO THE RESTART PATH. `limited`
   * stays true with `resetsAt: null`; that is an unknown ETA, not a non-limit.
   * Letting it fall through would reintroduce the false-negative as an
   * error-handling branch.
   */
  resetsAt: string | null;
}

/**
 * §5a DETECTION, then §5b EXTRACTION — deliberately separate.
 *
 * 🔑 THE ROOT CAUSE OF BOTH PRIOR DEFECTS: the reset clause was used as a
 * DETECTION term. It is not one — it is an EXTRACTION target. Detection asks
 * "is this agent quota-blocked"; the reset clause answers "until when", and only
 * matters once detection has already succeeded. Fusing them forces a choice
 * between anchoring the clause (too narrow) and wildcarding it (too broad).
 * ⇒ RULE: never put a field you want to EXTRACT into the predicate that decides
 * WHETHER to extract.
 */
export function detectUsageLimit(tail: string | null): UsageLimitVerdict {
  if (!tail) return { limited: false, resetsAt: null };
  const text = normaliseTail(tail);

  const hit = USAGE_LIMIT_MARKERS.find((m) => text.includes(m));
  if (!hit) return { limited: false, resetsAt: null };

  // §5b — only now. Search the MATCHED line, not the whole tail, so an unrelated
  // "resets" elsewhere in the buffer cannot supply a bogus ETA.
  const line = text.split('\n').find((l) => l.includes(hit)) ?? '';
  const m = /\bresets?\b\s+(.+?)\s*$/.exec(line);
  const resetsAt = m?.[1]?.trim() || null;
  return { limited: true, resetsAt: resetsAt && resetsAt.length > 0 ? resetsAt : null };
}

export type WedgePhase = 'clear' | 'probed' | 'confirmed';

/** Persisted per-agent wedge state (state/<agent>/wedge-state.json). */
export interface WedgeState {
  phase: WedgePhase;
  /** When the current probe was injected (ms), if phase === 'probed'. */
  probeSentAt?: number;
  /** Newest jsonl mtime captured at probe time — "advanced past this" = consumed. */
  jsonlMtimeAtProbe?: number | null;
  /** Heartbeat captured at probe time — "refreshed past this" = consumed. */
  heartbeatAtProbe?: number | null;
  nudgeCount: number;
  lastClearedAt?: number;
}

export function initialWedgeState(): WedgeState {
  return { phase: 'clear', nudgeCount: 0 };
}

export type Classification =
  | 'dead'
  | 'healthy-busy'
  | 'healthy-idle'
  | 'usage-limited'
  | 'wedge-candidate';

export interface Thresholds {
  tQuietMs: number;
  heartbeatStaleMs: number;
  probeGraceMs: number;
}

export function resolveThresholds(cfg: WedgeDetectionConfig | undefined): Thresholds {
  const min = 60_000;
  return {
    tQuietMs: (cfg?.t_quiet_min ?? 15) * min,
    heartbeatStaleMs: (cfg?.heartbeat_stale_min ?? 30) * min,
    probeGraceMs: (cfg?.probe_grace_min ?? 15) * min,
  };
}

/** Most-recent on-disk activity for an agent (max of jsonl + heartbeat). */
export function lastActivityMs(s: AgentSignals): number {
  return Math.max(s.jsonlMtimeMs ?? 0, s.heartbeatMs ?? 0);
}

/**
 * STAGE 1 — pure passive classification. Never decides "wedged" (that's the
 * probe's job); only nominates a wedge-candidate.
 */
export function classify(s: AgentSignals, t: Thresholds, now: number): Classification {
  if (!s.alive) return 'dead';
  const quietFor = now - (s.jsonlMtimeMs ?? 0);
  if (quietFor < t.tQuietMs) return 'healthy-busy'; // jsonl still advancing
  // Quiet. Owes nothing → correctly idle (the key false-positive guard).
  if (!s.owesWork) return 'healthy-idle';
  // Quiet + owes work + heartbeat stale → candidate to PROBE (not yet wedged).
  const hbStale = s.heartbeatMs === null || now - s.heartbeatMs >= t.heartbeatStaleMs;
  if (!hbStale) return 'healthy-idle';

  // §5a — INTERCEPT BEFORE NOMINATING. A quota-blocked session reaches this exact
  // point wearing every wedge signal; only the stdout CONTENT separates them, and
  // a restart cannot clear a quota (it restarts INTO the limit, re-blocks, and
  // loops to the cap). Checked here rather than at the action tier so the
  // classification itself is honest — the dashboard should not call it a wedge.
  if (detectUsageLimit(s.stdoutTail).limited) return 'usage-limited';

  return 'wedge-candidate';
}

/**
 * Host-suspend guard: a machine suspend makes ALL agents go quiet at once. If
 * ≥ 2 agents share a near-identical last-activity timestamp, suspect suspend
 * (not per-agent wedge) and suppress remediation this tick.
 */
export function looksLikeHostSuspend(all: AgentSignals[], coincidenceMs = 120_000): boolean {
  const acts = all.map(lastActivityMs).filter((v) => v > 0).sort((a, b) => a - b);
  for (let i = 1; i < acts.length; i++) {
    if (acts[i]! - acts[i - 1]! <= coincidenceMs) return true;
  }
  return false;
}

/** Actions the daemon exposes to the detector (kept side-effecting out of the pure core). */
export interface WedgeActions {
  /** Inject a non-dedupable nudge/probe; returns whether it was accepted for delivery. */
  probe(name: string, message: string): boolean;
  /** Escalate a confirmed wedge (to orchestrator, or direct-to-human if the wedged agent IS the orchestrator). */
  escalate(name: string, toHuman: boolean, detail: string): void;
  log(event: string, meta: Record<string, unknown>): void;
}

const PROBE_TEXT =
  'You appear idle with pending work. Check your inbox and in_progress tasks and ' +
  'continue, or update their status. (automated wedge-check probe)';

/**
 * Decide + act for ONE agent given its prior state. Returns the next state to
 * persist. Pure except for the injected `actions`. `suppressRemediation` is set
 * by the host-suspend guard.
 */
export function stepAgent(
  s: AgentSignals,
  prev: WedgeState,
  t: Thresholds,
  now: number,
  cfg: WedgeDetectionConfig,
  actions: WedgeActions,
  suppressRemediation: boolean,
): WedgeState {
  const maxAction = cfg.max_action ?? 'observe'; // safest default (Steve gate): detect+log only until promoted
  const cls = classify(s, t, now);

  // §5c — USAGE-LIMITED: surface + alert a human, NEVER restart, NEVER probe.
  // A probe is pointless (the session cannot consume it while blocked) and a
  // restart is actively harmful. Any in-flight probe state is dropped so the
  // agent cannot age into 'confirmed' while it is merely waiting out a quota.
  //
  // 🔴 THIS BRANCH MUST PRECEDE EVERY REMEDIATION PATH BELOW, including the
  // host-suspend guard: suppressRemediation only skips a tick, whereas this is a
  // standing "do not restart" for as long as the quota holds.
  if (cls === 'usage-limited') {
    const { resetsAt } = detectUsageLimit(s.stdoutTail);
    actions.log('wedge_usage_limited', {
      agent: s.name,
      // §5b parse failure is reported as an unknown ETA — it never downgrades the
      // classification, because that would restore the restart-into-quota path.
      resetsAt: resetsAt ?? 'unknown',
      from: prev.phase,
    });
    if (prev.phase !== 'clear') {
      actions.log('wedge_cleared', { agent: s.name, from: prev.phase, classification: cls });
    }
    if (maxAction === 'escalate') {
      actions.escalate(
        s.name,
        s.isOrchestrator,
        `${s.name} is USAGE-LIMITED (quota-blocked), not wedged: ` +
          `usage-limited until ${resetsAt ?? 'unknown'}. NO restart performed — a restart ` +
          `cannot clear a quota and would loop into the cap. No action needed unless this ` +
          `outlasts the stated reset.`,
      );
    }
    return { phase: 'clear', nudgeCount: 0, lastClearedAt: now };
  }

  // Any sign of life or a cleared queue resets an in-flight probe.
  if (cls === 'healthy-busy' || cls === 'healthy-idle' || cls === 'dead') {
    if (prev.phase !== 'clear') {
      actions.log('wedge_cleared', { agent: s.name, from: prev.phase, classification: cls });
    }
    return { phase: 'clear', nudgeCount: 0, lastClearedAt: now };
  }

  // cls === 'wedge-candidate' below.
  if (suppressRemediation) {
    actions.log('wedge_suppressed_host_suspend', { agent: s.name });
    return prev.phase === 'clear' ? prev : prev; // hold state; do not probe/escalate during suspected suspend
  }

  // Stage 2 — the inject-probe discriminator.
  if (prev.phase === 'clear') {
    if (maxAction === 'observe') {
      actions.log('wedge_candidate_observed', { agent: s.name });
      return prev;
    }
    const ok = actions.probe(s.name, PROBE_TEXT);
    actions.log('wedge_probe_sent', { agent: s.name, accepted: ok, nudge: 1 });
    return {
      phase: 'probed',
      probeSentAt: now,
      jsonlMtimeAtProbe: s.jsonlMtimeMs,
      heartbeatAtProbe: s.heartbeatMs,
      nudgeCount: 1,
    };
  }

  if (prev.phase === 'probed') {
    // Consumed? jsonl advanced OR heartbeat refreshed since the probe → healthy.
    const jsonlAdvanced =
      s.jsonlMtimeMs !== null && s.jsonlMtimeMs > (prev.jsonlMtimeAtProbe ?? -1);
    const hbRefreshed =
      s.heartbeatMs !== null && s.heartbeatMs > (prev.heartbeatAtProbe ?? -1);
    if (jsonlAdvanced || hbRefreshed) {
      actions.log('wedge_cleared', { agent: s.name, from: 'probed', reason: jsonlAdvanced ? 'jsonl' : 'heartbeat' });
      return { phase: 'clear', nudgeCount: 0, lastClearedAt: now };
    }
    // Not consumed yet. Within grace → wait (one re-nudge allowed).
    if (now - (prev.probeSentAt ?? now) < t.probeGraceMs) {
      if (prev.nudgeCount < 2 && maxAction !== 'observe') {
        const ok = actions.probe(s.name, PROBE_TEXT);
        actions.log('wedge_renudge', { agent: s.name, accepted: ok, nudge: prev.nudgeCount + 1 });
        return { ...prev, nudgeCount: prev.nudgeCount + 1 };
      }
      return prev;
    }
    // Grace elapsed, probe unconsumed → CONFIRMED wedge.
    actions.log('wedge_confirmed', { agent: s.name, quietMs: now - (s.jsonlMtimeMs ?? 0), nudges: prev.nudgeCount });
    if (maxAction === 'escalate') {
      // Orchestrator wedge escalates DIRECT to human (the escalate-to-orchestrator
      // rung is itself unavailable when the orchestrator is the wedged one).
      const detail =
        `${s.name} confirmed wedged: alive, quiet ${Math.round((now - (s.jsonlMtimeMs ?? 0)) / 60000)}m, ` +
        `owes work, ${prev.nudgeCount} unconsumed probe(s). NOTE: a stopped-agent restart can hit the ` +
        `bypass-dialog wall — if a restart crash-loops (uptime=seconds), STOP auto-restart and accept ` +
        `the Bypass dialog once interactively (TTY). Do not auto-loop.`;
      actions.escalate(s.name, s.isOrchestrator, detail);
    }
    return { ...prev, phase: 'confirmed' };
  }

  // phase === 'confirmed': already escalated; hold until it clears (handled above) or a human acts.
  return prev;
}
