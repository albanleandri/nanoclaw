/**
 * Interactive MCP tools: ask_user_question, send_card.
 *
 * ask_user_question is a blocking tool call — it writes a messages_out row
 * with a question card, then polls messages_in for the response.
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { getCurrentInReplyTo } from '../current-batch.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function routing() {
  return getSessionRouting();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// http(s) only: the one scheme every adapter renders as a link button. Requires
// a host character and no whitespace, so placeholders like "#" or "/docs" (an
// agent faking a callback button) and markdown-breaking urls are dropped.
const WEB_LINK = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

/**
 * send_card is fire-and-forget, so the bridge drops every action without a url
 * (no callback buttons). Filter invalid actions here and report the count, so
 * the agent learns why a button did not appear instead of blaming the
 * platform (ported from upstream b76fcb3d, without its AJV schema).
 */
export function keepLinkActions(card: Record<string, unknown>): { card: Record<string, unknown>; dropped: number } {
  if (!Array.isArray(card.actions)) return { card, dropped: 0 };
  const kept = card.actions.filter((a): boolean => {
    if (!a || typeof a !== 'object') return false;
    const { label, url } = a as Record<string, unknown>;
    return typeof label === 'string' && label.trim() !== '' && typeof url === 'string' && WEB_LINK.test(url);
  });
  return { card: { ...card, actions: kept }, dropped: card.actions.length - kept.length };
}

export const askUserQuestion: McpToolDefinition = {
  tool: {
    name: 'ask_user_question',
    description:
      'Ask the user a multiple-choice question and wait for their response. This is a blocking call — execution pauses until the user responds or the timeout expires. Provide a short card title (e.g. "Confirm deletion") and an array of options — each option may be a plain string (used as both button label and result value) or an object { label, selectedLabel?, value? } where selectedLabel is the text shown on the card after the user clicks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short card title shown above the question' },
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  selectedLabel: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            ],
          },
          description: 'Options for the user to choose from (string or {label, selectedLabel?, value?})',
        },
        multiple: {
          type: 'boolean',
          description:
            'When true, render checkbox-style multi-select and return selected values as a comma-separated list',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 300)' },
      },
      required: ['title', 'question', 'options'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const question = args.question as string;
    const rawOptions = args.options as unknown[];
    const multiple = (args.multiple as boolean) || false;
    const timeout = ((args.timeout as number) || 300) * 1000;
    if (!title || !question || !rawOptions?.length) {
      return err('title, question, and options are required');
    }

    const options = rawOptions.map((o) => {
      if (typeof o === 'string') return { label: o, selectedLabel: o, value: o };
      const obj = o as { label: string; selectedLabel?: string; value?: string };
      return {
        label: obj.label,
        selectedLabel: obj.selectedLabel ?? obj.label,
        value: obj.value ?? obj.label,
      };
    });

    const questionId = generateId();
    const r = routing();
    const inReplyTo = getCurrentInReplyTo();

    // Write question card to outbound.db
    writeMessageOut({
      id: questionId,
      in_reply_to: inReplyTo,
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        type: 'ask_question',
        questionId,
        title,
        question,
        options,
        multiple,
      }),
    });
    if (inReplyTo) markCompleted([inReplyTo]);

    log(`ask_user_question: ${questionId} → "${question}" [${options.join(', ')}]`);

    // Poll for response in inbound.db (host writes the response there)
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const response = findQuestionResponse(questionId);

      if (response) {
        const parsed = JSON.parse(response.content);
        // Mark the response as completed via processing_ack (outbound.db)
        markCompleted([response.id]);

        log(`ask_user_question response: ${questionId} → ${parsed.selectedOption}`);
        return ok(parsed.selectedOption);
      }

      await sleep(1000);
    }

    log(`ask_user_question timeout: ${questionId}`);
    return err(`Question timed out after ${timeout / 1000}s`);
  },
};

export const sendCard: McpToolDefinition = {
  tool: {
    name: 'send_card',
    description:
      'Send a display-only card (title, description, children, optional web-link buttons) to the current conversation. ' +
      'Returns immediately. Never renders callback buttons: to let the user choose something, use ask_user_question.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        card: {
          type: 'object',
          description:
            'Card with title, description, children (strings or { text }), and optional top-level actions. ' +
            'Each action is { label, url, style? } where url is an http(s) web link; other actions are dropped.',
        },
        fallbackText: { type: 'string', description: 'Plain-text version for channels that render cards as text' },
      },
      required: ['card'],
    },
  },
  async handler(args) {
    const card = args.card as Record<string, unknown>;
    if (!card) return err('card is required');

    const { card: sentCard, dropped } = keepLinkActions(card);
    const id = generateId();
    const r = routing();

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat-sdk',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({ type: 'card', card: sentCard, fallbackText: (args.fallbackText as string) || '' }),
    });

    log(`send_card: ${id}${dropped ? ` (${dropped} action(s) dropped)` : ''}`);
    if (dropped === 0) return ok(`Card sent (id: ${id})`);
    return ok(
      `Card sent (id: ${id}). ${dropped} action(s) were dropped: send_card only renders link buttons with an ` +
        `http(s) url. For a button the user can click to answer, use ask_user_question.`,
    );
  },
};

registerTools([askUserQuestion, sendCard]);
