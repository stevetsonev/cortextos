import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isTelegramHeld } from '../../../src/telegram/hold';

describe('isTelegramHeld', () => {
  let ctxRoot: string;
  const agent = 'jordan-blake';

  beforeEach(() => {
    ctxRoot = mkdtempSync(join(tmpdir(), 'cortextos-hold-'));
    mkdirSync(join(ctxRoot, 'state', agent), { recursive: true });
  });

  afterEach(() => {
    rmSync(ctxRoot, { recursive: true, force: true });
  });

  it('returns true when the .telegram-hold flag is present', () => {
    writeFileSync(join(ctxRoot, 'state', agent, '.telegram-hold'), 'HELD', 'utf-8');
    expect(isTelegramHeld(ctxRoot, agent)).toBe(true);
  });

  it('returns false when the flag is absent (state dir exists, no flag)', () => {
    expect(isTelegramHeld(ctxRoot, agent)).toBe(false);
  });

  it('returns false for an agent whose state dir does not exist at all', () => {
    expect(isTelegramHeld(ctxRoot, 'no-such-agent')).toBe(false);
  });

  // FAIL CLOSED: the whole point is that an unresolvable path must never read
  // as "not held" and leak a send. Empty ctxRoot/agentName -> HELD.
  it('FAILS CLOSED (held) when ctxRoot is empty — cannot determine, do not leak', () => {
    expect(isTelegramHeld('', agent)).toBe(true);
  });

  it('FAILS CLOSED (held) when agentName is empty', () => {
    expect(isTelegramHeld(ctxRoot, '')).toBe(true);
  });

  it('FAILS CLOSED (held) when ctxRoot is undefined/null', () => {
    expect(isTelegramHeld(undefined, agent)).toBe(true);
    expect(isTelegramHeld(null, agent)).toBe(true);
  });

  it('does NOT treat a flag under a DIFFERENT agent as this agent being held', () => {
    mkdirSync(join(ctxRoot, 'state', 'someone-else'), { recursive: true });
    writeFileSync(join(ctxRoot, 'state', 'someone-else', '.telegram-hold'), 'HELD', 'utf-8');
    expect(isTelegramHeld(ctxRoot, agent)).toBe(false);
  });
});
