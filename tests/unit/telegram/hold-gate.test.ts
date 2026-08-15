import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TelegramAPI } from '../../../src/telegram/api';

// Reuse the send-message.test.ts fetch-stub shape: the stub THROWS if called
// with no queued response, which is exactly how we prove a suppressed send
// never touched the network — queue nothing, assert fetch was never called.
type MockResponse = { status: number; body: any };
let responseQueue: MockResponse[] = [];
let callLog: Array<{ url: string; body: any }> = [];

function queue(r: MockResponse): void {
  responseQueue.push(r);
}

let ctxRoot: string;
const agent = 'jordan-blake';
const chatId = '8569199291';
const outboundLog = () => join(ctxRoot, 'logs', agent, 'outbound-messages.jsonl');
function readOutbound(): any[] {
  if (!existsSync(outboundLog())) return [];
  return readFileSync(outboundLog(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
function setHeld(held: boolean): void {
  const flag = join(ctxRoot, 'state', agent, '.telegram-hold');
  if (held) writeFileSync(flag, 'HELD', 'utf-8');
  else if (existsSync(flag)) rmSync(flag);
}

beforeEach(() => {
  responseQueue = [];
  callLog = [];
  ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-holdgate-'));
  mkdirSync(join(ctxRoot, 'state', agent), { recursive: true });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      callLog.push({ url, body });
      const next = responseQueue.shift();
      if (!next) throw new Error('fetch called with no queued response');
      return { ok: next.status === 200, status: next.status, json: async () => next.body } as any;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(ctxRoot, { recursive: true, force: true });
});

describe('TelegramAPI.sendMessage telegram-hold gate', () => {
  it('SUPPRESSES a daemon-auto send while held — never touches the network', async () => {
    setHeld(true);
    const api = new TelegramAPI('111:AAA');
    // Queue nothing: if the gate leaks, fetch throws and the test fails loudly.
    const result = await api.sendMessage(chatId, 'Agent jordan-blake is back online', undefined, {
      hold: { ctxRoot, agentName: agent },
    });

    expect(callLog).toHaveLength(0); // network never called
    expect(result?.suppressed).toBe(true);
    expect(result?.reason).toBe('telegram-hold');
  });

  it('LOGS the suppressed attempt so "was a send attempted while held" is answerable', async () => {
    setHeld(true);
    const api = new TelegramAPI('111:AAA');
    await api.sendMessage(chatId, 'crash alert', undefined, { hold: { ctxRoot, agentName: agent } });

    const entries = readOutbound();
    expect(entries).toHaveLength(1);
    expect(entries[0].suppressed).toBe(true);
    expect(entries[0].suppress_reason).toBe('telegram-hold');
    expect(entries[0].message_id).toBe(0); // never reached Telegram
    expect(entries[0].text).toBe('crash alert');
  });

  it('SENDS a daemon-auto send when NOT held, and logs it as a real (typed) send', async () => {
    setHeld(false);
    queue({ status: 200, body: { ok: true, result: { message_id: 4242 } } });
    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage(chatId, 'recovered', undefined, {
      hold: { ctxRoot, agentName: agent },
    });

    expect(callLog).toHaveLength(1);
    expect(callLog[0].url).toContain('/sendMessage');
    expect(result?.result?.message_id).toBe(4242);

    const entries = readOutbound();
    expect(entries).toHaveLength(1);
    expect(entries[0].suppressed).toBeUndefined(); // real send, not suppressed
    expect(entries[0].message_id).toBe(4242);
  });

  // THE DEADLOCK GUARD. Reply / agent-driven / interactive-hook paths pass NO
  // hold context. They MUST send even when the flag is present, or the hold
  // strands the user and can never be lifted (the lift condition is the user
  // messaging first, which requires the agent to be able to reply).
  it('DOES NOT gate a send that passes no hold context, even while held', async () => {
    setHeld(true);
    queue({ status: 200, body: { ok: true, result: { message_id: 7 } } });
    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage(chatId, 'reply to the user');

    expect(callLog).toHaveLength(1); // sent — reply path is never gated
    expect(result?.result?.message_id).toBe(7);
    expect(readOutbound()).toHaveLength(0); // no hold context -> gate/logging untouched
  });

  it('FAILS CLOSED: hold context with an empty agentName suppresses (does not leak)', async () => {
    setHeld(false); // flag absent, but agentName is unresolvable
    const api = new TelegramAPI('111:AAA');
    const result = await api.sendMessage(chatId, 'x', undefined, { hold: { ctxRoot, agentName: '' } });
    expect(callLog).toHaveLength(0);
    expect(result?.suppressed).toBe(true);
  });
});
