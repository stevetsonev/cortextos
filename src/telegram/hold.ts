/**
 * Telegram hold gate — a CODE-LEVEL check for the per-agent `.telegram-hold`
 * flag.
 *
 * Background: the hold has historically been an INSTRUCTION-level control — a
 * block in AGENTS.md that a session must read and obey before it sends. That
 * catches the sends an agent *chooses* to make (`cortextos bus send-telegram`),
 * but it does NOT catch the sends the DAEMON makes on the agent's behalf
 * (crash/HALTED/recovered notifications, runtime lifecycle "back online" pings,
 * watchdog alerts). Those call `TelegramAPI.sendMessage()` directly and no
 * session is in the loop to refuse them. Gating `cortextos bus send-telegram`
 * catches none of them. This module is the check those daemon paths were
 * missing.
 *
 * The flag lives at `<ctxRoot>/state/<agentName>/.telegram-hold`. Its presence
 * means: agent-INITIATED sends to the user are HELD. (Replies are allowed, but
 * that distinction is the CALLER's — the daemon-auto paths gated here are never
 * replies, so they simply do not pass a hold context on a reply path.)
 */

import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Returns true if agent-INITIATED Telegram sends are currently HELD for this
 * agent.
 *
 * FAIL CLOSED, on purpose. If `ctxRoot` or `agentName` is missing/empty the
 * path would collapse to something like `state//​.telegram-hold`, which is
 * absent, which a naive existence check reads as "not held" — i.e. it would
 * LEAK a send during a hold precisely when the environment is unresolvable.
 * An inability to determine the hold state is treated as HELD. This mirrors
 * the fail-closed logic the AGENTS.md gate block already uses in bash.
 *
 * Any filesystem error is likewise treated as HELD — "I could not look" must
 * never be reported as "the flag is absent".
 */
export function isTelegramHeld(
  ctxRoot: string | undefined | null,
  agentName: string | undefined | null,
): boolean {
  if (!ctxRoot || !agentName) return true; // fail closed: unresolvable -> held
  try {
    return existsSync(join(ctxRoot, 'state', agentName, '.telegram-hold'));
  } catch {
    return true; // fail closed on any fs error
  }
}

/**
 * Hold context threaded into `TelegramAPI.sendMessage` by daemon-auto call
 * sites. Presence of this object on a send is what opts that send into the
 * gate; reply/agent-driven/interactive paths pass nothing and are never gated.
 */
export interface TelegramHoldContext {
  ctxRoot: string;
  agentName: string;
}
