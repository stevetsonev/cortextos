/**
 * Local-inference usage helpers for the dashboard's Ollama widget.
 *
 * Reads the append-only JSONL that `agents/maria/scripts/ollama-run.sh` writes
 * on every local model call (one row per call: model, token counts from the
 * Ollama API's own prompt_eval_count/eval_count, task label, timestamp).
 *
 * "Cost avoided" is deliberately benchmarked against Claude Haiku 4.5 — these
 * are low-stakes classification/labelling tasks, so Haiku is the model they'd
 * realistically have used. Benchmarking against Opus would inflate the figure.
 * Rates are $/million tokens and are stated in the response so the UI can label
 * the comparison rather than presenting a bare number.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const USAGE_LOG = path.join(
  process.env.CTX_ROOT ?? path.join(os.homedir(), '.cortextos', 'default'),
  'state',
  'local-inference',
  'usage.jsonl',
);

/**
 * Claude Haiku 4.5 list price, $ per million tokens.
 *
 * ⚠️ HAIKU IS DELIBERATE — DO NOT "UPGRADE" THIS TO OPUS.
 * The work being displaced here is low-stakes labelling and classification, so
 * Haiku is the model these calls would realistically have used. Benchmarking
 * against Opus ($5/$25) would inflate the displayed saving 5-25x and make the
 * metric marketing rather than measurement. If you change these rates, change
 * `model` with them — the UI renders it as "vs <model>" so the claim stays
 * falsifiable, and a rate that no longer matches its label is a silent lie.
 */
const BENCHMARK = { model: 'claude-haiku-4-5', inputPerM: 1.0, outputPerM: 5.0 };

interface UsageRow {
  ts: string;
  task: string;
  model: string;
  kind: 'text' | 'vision' | 'audio';
  in_tokens: number;
  out_tokens: number;
  seconds: number;
  ok: boolean;
  /** Present only on audio rows. */
  minutes?: number;
}

export interface LocalInferenceSnapshot {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  whisperMinutes: number;
  /** USD that would have been spent running the same tokens on the benchmark model. */
  costAvoidedUsd: number;
  benchmarkModel: string;
  byModel: { model: string; calls: number; inputTokens: number; outputTokens: number }[];
  byTask: { task: string; calls: number }[];
  firstSeen: string | null;
  lastSeen: string | null;
}

/** Returns null when no local-inference has been logged yet (cold start). */
export function readLocalInferenceUsage(): LocalInferenceSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(USAGE_LOG, 'utf8');
  } catch {
    return null; // log doesn't exist yet — component renders "no data yet"
  }

  const rows: UsageRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as UsageRow);
    } catch {
      // A partially-written final line is normal for an append-only log
      // being read mid-write. Skip it rather than failing the whole request.
    }
  }
  if (rows.length === 0) return null;

  const models = new Map<string, { calls: number; inputTokens: number; outputTokens: number }>();
  const tasks = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let whisperMinutes = 0;
  let failed = 0;

  for (const r of rows) {
    inputTokens += r.in_tokens ?? 0;
    outputTokens += r.out_tokens ?? 0;
    whisperMinutes += r.minutes ?? 0;
    if (!r.ok) failed += 1;

    const m = models.get(r.model) ?? { calls: 0, inputTokens: 0, outputTokens: 0 };
    m.calls += 1;
    m.inputTokens += r.in_tokens ?? 0;
    m.outputTokens += r.out_tokens ?? 0;
    models.set(r.model, m);

    tasks.set(r.task, (tasks.get(r.task) ?? 0) + 1);
  }

  const costAvoidedUsd =
    (inputTokens / 1_000_000) * BENCHMARK.inputPerM +
    (outputTokens / 1_000_000) * BENCHMARK.outputPerM;

  const timestamps = rows.map((r) => r.ts).filter(Boolean).sort();

  return {
    calls: rows.length,
    failed,
    inputTokens,
    outputTokens,
    whisperMinutes,
    costAvoidedUsd,
    benchmarkModel: BENCHMARK.model,
    byModel: [...models.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.calls - a.calls),
    byTask: [...tasks.entries()]
      .map(([task, calls]) => ({ task, calls }))
      .sort((a, b) => b.calls - a.calls),
    firstSeen: timestamps[0] ?? null,
    lastSeen: timestamps[timestamps.length - 1] ?? null,
  };
}
