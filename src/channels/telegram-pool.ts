/**
 * Telegram bot pool for agent-swarm / agent-teams support.
 *
 * Maintains a set of send-only bots. Each agent group is assigned a bot
 * deterministically (stable across restarts within a process lifetime) so
 * different agents appear as different Telegram identities.
 *
 * Pool bots do NOT poll — only the main adapter in telegram.ts polls.
 */

import { log } from '../log.js';
import { parseTextStyles } from '../text-styles.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_TEXT_LENGTH = 4000;

interface PoolBot {
  token: string;
  username: string;
}

const poolBots: PoolBot[] = [];
const agentBotMap = new Map<string, number>(); // agentGroupId → pool bot index
let nextPoolIndex = 0;

async function tgFetch(token: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json() as Promise<{ ok: boolean; result?: Record<string, unknown> }>;
}

function splitText(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split('\n\n');
  let current = '';
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > MAX_TEXT_LENGTH) {
      if (current) chunks.push(current.trim());
      current = para.length > MAX_TEXT_LENGTH ? para.slice(0, MAX_TEXT_LENGTH) : para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

export async function initTelegramPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const data = await tgFetch(token, 'getMe', {});
      if (data.ok && data.result) {
        const username = (data.result.username as string) ?? 'unknown';
        poolBots.push({ token, username });
        log.info('Pool bot initialized', { username, poolSize: poolBots.length });
      }
    } catch (err) {
      log.error('Failed to initialize pool bot', { err });
    }
  }
  if (poolBots.length > 0) {
    log.info('Telegram bot pool ready', { count: poolBots.length });
  }
}

export function hasPoolBots(): boolean {
  return poolBots.length > 0;
}

/**
 * Deliver a message via a pool bot assigned to the given agent group.
 *
 * Callers MUST supply an explicit `bot_index` in `parsedContent`. Without it the
 * function falls back to round-robin per sender/group, which is non-persistent
 * across restarts and produces inconsistent identities. The delivery.ts guard
 * enforces this: it only calls this function when `bot_index` is a number.
 *
 * Returns the first message ID on success, undefined if pool is not configured
 * or if the content has no text.
 */
export async function deliverViaPool(
  agentGroupId: string,
  platformId: string,
  parsedContent: Record<string, unknown>,
): Promise<string | undefined> {
  if (poolBots.length === 0) return undefined;

  const explicitBotIndex = typeof parsedContent.bot_index === 'number' ? parsedContent.bot_index : undefined;
  const sender = typeof parsedContent.sender === 'string' ? parsedContent.sender : undefined;

  let idx: number;

  if (explicitBotIndex !== undefined) {
    // Pinned assignment — use the requested index directly, no rename.
    idx = explicitBotIndex % poolBots.length;
    log.info('Pool bot selected by explicit bot_index', { agentGroupId, bot_index: explicitBotIndex, poolIndex: idx });
  } else {
    // Stable assignment per sender (if provided) or agent group.
    const assignmentKey = sender !== undefined ? `sender:${sender}` : `group:${agentGroupId}`;
    let existing = agentBotMap.get(assignmentKey);
    if (existing === undefined) {
      existing = nextPoolIndex % poolBots.length;
      nextPoolIndex++;
      agentBotMap.set(assignmentKey, existing);
      log.info('Pool bot assigned', {
        assignmentKey,
        poolIndex: existing,
        bot: poolBots[existing].username,
      });
    }
    idx = existing;
  }

  const bot = poolBots[idx];

  // Extract text from content JSON
  const rawText = (parsedContent.markdown as string) || (parsedContent.text as string);
  if (!rawText) return undefined;

  // Apply the same transform pipeline as the main adapter
  const text = sanitizeTelegramLegacyMarkdown(parseTextStyles(rawText, 'telegram'));

  // Extract numeric chat ID (platform_id is "telegram:123456789" or bare "123456789")
  const chatId = platformId.replace(/^telegram:/, '');

  let firstId: string | undefined;
  for (const chunk of splitText(text)) {
    try {
      const result = await tgFetch(bot.token, 'sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'Markdown',
      });
      if (result.ok && result.result && !firstId) {
        firstId = String((result.result as { message_id?: number }).message_id ?? '');
      }
    } catch (err) {
      log.error('Pool bot send failed', { agentGroupId, chatId, err });
    }
  }

  return firstId;
}
