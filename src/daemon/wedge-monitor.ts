/**
 * Wedge monitor — the daemon glue around the pure wedge-detector core.
 *
 * On a timer (only while at least one agent has `wedge_detection.enabled`), it
 * gathers each agent's on-disk signals, drives `stepAgent`, and persists the
 * per-agent wedge state. All side effects (fs reads, PTY inject, bus message)
 * live here; the decision logic stays pure in wedge-detector.ts.
 *
 * Default-OFF and non-destructive: the prototype tops out at 'escalate' (probe +
 * notify) — it never restarts an agent (a stopped agent can hit the bypass-dialog
 * wall; that recovery is a human step, carried in the escalation text).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig } from '../types/index.js';
import type { AgentProcess } from './agent-process.js';
import { resolvePaths } from '../utils/paths.js';
import { sendMessage } from '../bus/message.js';
import {
  stepAgent,
  looksLikeHostSuspend,
  resolveThresholds,
  initialWedgeState,
  type AgentSignals,
  type WedgeState,
  type WedgeActions,
} from './wedge-detector.js';

export interface MonitoredAgent {
  name: string;
  process: AgentProcess;
  config: AgentConfig;
  agentDir: string;
  org: string;
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** Newest .jsonl mtime in the agent's Claude conversation dir, or null. */
function jsonlMtimeMs(agentDir: string): number | null {
  const convDir = join(homedir(), '.claude', 'projects', agentDir.split(sep).join('-'));
  try {
    let newest = 0;
    for (const f of readdirSync(convDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const m = statSync(join(convDir, f)).mtimeMs;
      if (m > newest) newest = m;
    }
    return newest || null;
  } catch {
    return null;
  }
}

/** last_heartbeat epoch ms from the agent's state dir, or null. */
function heartbeatMs(stateDir: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, 'heartbeat.json'), 'utf8'));
    const t = Date.parse(raw.last_heartbeat);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Does the agent owe work? Conservative prototype signals:
 *   - an in_progress task for this agent not updated in > 2h, OR
 *   - a non-empty inbox (undelivered messages).
 * (A fired-cron-with-no-handling signal is a documented future addition; it
 * needs cron-execution-log correlation and is easy to false-flag on no-op crons.)
 */
function owesWork(taskDir: string, inboxDir: string, name: string, now: number): boolean {
  try {
    for (const f of readdirSync(taskDir)) {
      if (!f.endsWith('.json')) continue;
      const t = JSON.parse(readFileSync(join(taskDir, f), 'utf8'));
      const assignee = t.assignee ?? t.agent;
      if (assignee === name && t.status === 'in_progress') {
        const updated = Date.parse(t.updated_at ?? t.updatedAt ?? '');
        if (!Number.isFinite(updated) || now - updated > TWO_HOURS_MS) return true;
      }
    }
  } catch { /* no task dir yet */ }
  try {
    if (existsSync(inboxDir) && readdirSync(inboxDir).some((f) => f.endsWith('.json'))) return true;
  } catch { /* ignore */ }
  return false;
}

function loadState(stateDir: string): WedgeState {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'wedge-state.json'), 'utf8')) as WedgeState;
  } catch {
    return initialWedgeState();
  }
}

function saveState(stateDir: string, state: WedgeState): void {
  try { mkdirSync(stateDir, { recursive: true }); } catch { /* exists */ }
  writeFileSync(join(stateDir, 'wedge-state.json'), JSON.stringify(state));
}

export class WedgeMonitor {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly instanceId: string,
    private readonly getAgents: () => MonitoredAgent[],
    private readonly notifyHuman: (text: string) => void,
    private readonly logEvent: (agent: string, event: string, meta: Record<string, unknown>) => void,
    private readonly tickMs = 5 * 60 * 1000, // watchdog cadence
  ) {}

  /** Start ticking only if some agent has wedge detection enabled. */
  start(): void {
    if (this.timer) return;
    if (!this.getAgents().some((a) => a.config.wedge_detection?.enabled)) return; // stays fully inert
    this.timer = setInterval(() => {
      try { this.tick(Date.now()); } catch (err) {
        console.error('[wedge-monitor] tick error', err);
      }
    }, this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** One watchdog pass. Exposed for tests/manual runs. */
  tick(now: number): void {
    const agents = this.getAgents().filter((a) => a.config.wedge_detection?.enabled);
    if (agents.length === 0) return;

    const paths = new Map(agents.map((a) => [a.name, resolvePaths(a.name, this.instanceId, a.org)]));

    const signals: AgentSignals[] = agents.map((a) => {
      const p = paths.get(a.name)!;
      return {
        name: a.name,
        alive: a.process.getStatus().status === 'running',
        isOrchestrator: !!a.config.wedge_detection?.is_orchestrator,
        jsonlMtimeMs: jsonlMtimeMs(a.agentDir),
        heartbeatMs: heartbeatMs(p.stateDir),
        uptimeMs: 0, // reserved for the (out-of-prototype-scope) restart tier
        owesWork: owesWork(p.taskDir, p.inbox, a.name, now),
      };
    });

    const suppress = looksLikeHostSuspend(signals);
    const orchestrator = agents.find((a) => a.config.wedge_detection?.is_orchestrator)?.name ?? 'morgan-quinn';

    for (const a of agents) {
      const s = signals.find((x) => x.name === a.name)!;
      const p = paths.get(a.name)!;
      const cfg = a.config.wedge_detection!;
      const actions: WedgeActions = {
        probe: (_name, msg) => a.process.injectMessageDetailed(msg).ok,
        escalate: (_name, toHuman, detail) => {
          if (toHuman) this.notifyHuman(`⚠️ WEDGE: ${detail}`);
          else sendMessage(resolvePaths(orchestrator, this.instanceId, a.org), 'daemon-wedge', orchestrator, 'high', `⚠️ agent_wedged: ${detail}`);
        },
        log: (event, meta) => this.logEvent(a.name, event, meta),
      };
      const next = stepAgent(s, loadState(p.stateDir), resolveThresholds(cfg), now, cfg, actions, suppress);
      saveState(p.stateDir, next);
    }
  }
}
