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

export type Classification = 'dead' | 'healthy-busy' | 'healthy-idle' | 'wedge-candidate';

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
  return hbStale ? 'wedge-candidate' : 'healthy-idle';
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
