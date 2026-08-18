'use client';

import { useEffect, useState } from 'react';
import { IconCpu } from '@tabler/icons-react';

type LocalInferenceSnapshot = {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  whisperMinutes: number;
  costAvoidedUsd: number;
  benchmarkModel: string;
  byModel: { model: string; calls: number; inputTokens: number; outputTokens: number }[];
  byTask: { task: string; calls: number }[];
  firstSeen: string | null;
  lastSeen: string | null;
};

const POLL_MS = 60_000;

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Local (Ollama) inference usage. Every row is written by ollama-run.sh at call
 * time, so this reflects actual calls rather than an estimate.
 */
export function LocalInferenceCard() {
  const [data, setData] = useState<LocalInferenceSnapshot | null>(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/local-inference');
        if (!res.ok) {
          if (!cancelled) setEmpty(true);
          return;
        }
        const json = (await res.json()) as LocalInferenceSnapshot;
        if (!cancelled) {
          setData(json);
          setEmpty(false);
        }
      } catch {
        if (!cancelled) setEmpty(true);
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (empty || !data) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/5 p-4">
        <div className="flex items-center gap-2 text-sm font-medium text-white/80">
          <IconCpu size={16} aria-hidden />
          Local inference
        </div>
        <p className="mt-2 text-sm text-white/50">No local model calls logged yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-white/80">
        <IconCpu size={16} aria-hidden />
        Local inference
        <span className="ml-auto text-xs font-normal text-white/40">
          {data.calls} call{data.calls === 1 ? '' : 's'}
          {/* Failures are stated in words, not signalled by colour alone. */}
          {data.failed > 0 ? ` · ${data.failed} failed` : ''}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-3">
        <div>
          <div className="text-lg tabular-nums text-white">{compact(data.inputTokens)}</div>
          <div className="text-xs text-white/50">tokens in</div>
        </div>
        <div>
          <div className="text-lg tabular-nums text-white">{compact(data.outputTokens)}</div>
          <div className="text-xs text-white/50">tokens out</div>
        </div>
        <div>
          <div className="text-lg tabular-nums text-emerald-300">
            ${data.costAvoidedUsd.toFixed(2)}
          </div>
          {/* Name the benchmark — a bare "saved" number would be unfalsifiable. */}
          <div className="text-xs text-white/50">vs {data.benchmarkModel}</div>
        </div>
      </div>

      {data.whisperMinutes > 0 && (
        <div className="mt-2 text-xs text-white/50">
          {data.whisperMinutes.toFixed(1)} min transcribed
        </div>
      )}

      {data.byModel.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-white/10 pt-2">
          {data.byModel.map((m) => (
            <li key={m.model} className="flex justify-between text-xs text-white/60">
              <span className="truncate">{m.model}</span>
              <span className="tabular-nums">{m.calls}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
