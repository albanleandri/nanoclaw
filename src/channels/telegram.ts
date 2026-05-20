import https from 'https';
import { Api, Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { AskQuestionPayload } from './ask-question.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Split text into chunks no larger than maxLength, preferring paragraph, line,
 * or word boundaries over arbitrary character splits to keep Markdown balanced.
 */
export function splitAtBoundary(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const paraBreak = remaining.lastIndexOf('\n\n', maxLength);
    if (paraBreak > 0) {
      chunks.push(remaining.slice(0, paraBreak + 2));
      remaining = remaining.slice(paraBreak + 2);
      continue;
    }
    const lineBreak = remaining.lastIndexOf('\n', maxLength);
    if (lineBreak > 0) {
      chunks.push(remaining.slice(0, lineBreak + 1));
      remaining = remaining.slice(lineBreak + 1);
      continue;
    }
    const wordBreak = remaining.lastIndexOf(' ', maxLength);
    if (wordBreak > 0) {
      chunks.push(remaining.slice(0, wordBreak + 1));
      remaining = remaining.slice(wordBreak + 1);
      continue;
    }
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

/**
 * Normalize agent Markdown output to Telegram Markdown v1 before sending.
 * Agents produce GitHub-flavoured Markdown; Telegram uses a strict subset.
 */
export function sanitizeTelegramText(text: string): string {
  return text
    .replace(/\*\*/g, '*')
    .replace(/_{2}/g, '_')
    .replace(/^#{2,}\s*/gm, '')
    .replace(/^[ \t]*---+[ \t]*\n?/gm, '')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  const sanitized = sanitizeTelegramText(text);
  try {
    await api.sendMessage(chatId, sanitized, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    log.debug('Markdown send failed, falling back to plain text', { err });
    await api.sendMessage(chatId, sanitized, options);
  }
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      log.info('Pool bot initialized', { username: me.username, id: me.id, poolSize: poolApis.length });
    } catch (err) {
      log.error('Failed to initialize pool bot', { err });
    }
  }
  if (poolApis.length > 0) {
    log.info('Telegram bot pool ready', { count: poolApis.length });
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  pinnedIndex?: number,
): Promise<void> {
  if (poolApis.length === 0) {
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = pinnedIndex !== undefined ? pinnedIndex % poolApis.length : nextPoolIndex % poolApis.length;
    if (pinnedIndex === undefined) nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      log.info('Assigned and renamed pool bot', { sender, groupFolder, poolIndex: idx });
    } catch (err) {
      log.warn('Failed to rename pool bot (sending anyway)', { sender, err });
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^telegram:/, '');
    for (const chunk of splitAtBoundary(text, 4096)) {
      await sendTelegramMessage(api, numericId, chunk);
    }
    log.info('Pool message sent', { chatId, sender, poolIndex: idx, length: text.length });
  } catch (err) {
    log.error('Failed to send pool message', { chatId, sender, err });
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | null | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof (content as Record<string, unknown>).text === 'string') {
    return (content as Record<string, unknown>).text as string;
  }
  return null;
}

function createTelegramAdapter(botToken: string): ChannelAdapter {
  let bot: Bot | null = null;
  let channelSetup: ChannelSetup | null = null;

  // Track pending single-select ask_question keyboards: messageId → { platformId, questionId }
  const pendingKeyboards = new Map<number, { platformId: string; questionId: string }>();

  const adapter: ChannelAdapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      channelSetup = config;
      bot = new Bot(botToken, {
        client: {
          baseFetchConfig: { agent: https.globalAgent, compress: true },
        },
      });

      bot.command('chatid', (ctx) => {
        const chatId = ctx.chat.id;
        const chatType = ctx.chat.type;
        const chatName =
          chatType === 'private'
            ? ctx.from?.first_name || 'Private'
            : (ctx.chat as { title?: string }).title || 'Unknown';
        ctx.reply(`Chat ID: \`telegram:${chatId}\`\nName: ${chatName}\nType: ${chatType}`, { parse_mode: 'Markdown' });
      });

      bot.command('ping', (ctx) => {
        ctx.reply(`${ASSISTANT_NAME} is online.`);
      });

      const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

      bot.on('message:text', async (ctx) => {
        if (ctx.message.text.startsWith('/')) {
          const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
          if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
        }

        const platformId = `telegram:${ctx.chat.id}`;
        let content = ctx.message.text;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id.toString() || 'Unknown';
        const senderId = ctx.from?.id.toString() || '';
        const msgId = ctx.message.message_id.toString();

        const chatName =
          ctx.chat.type === 'private' ? senderName : (ctx.chat as { title?: string }).title || platformId;

        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        // Translate @bot_username mentions into TRIGGER_PATTERN format
        const botUsername = ctx.me?.username?.toLowerCase();
        let isMention = false;
        if (botUsername) {
          const entities = ctx.message.entities || [];
          isMention = entities.some((entity) => {
            if (entity.type === 'mention') {
              const mentionText = content.substring(entity.offset, entity.offset + entity.length).toLowerCase();
              return mentionText === `@${botUsername}`;
            }
            return false;
          });
          if (isMention && !TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }

        config.onMetadata(platformId, chatName, isGroup);

        config.onInbound(platformId, null, {
          id: msgId,
          kind: 'chat',
          content: {
            text: content,
            sender: senderName,
            senderId: `telegram:${senderId}`,
          },
          timestamp,
          isMention,
          isGroup,
        });

        log.info('Telegram message stored', { platformId, chatName, sender: senderName });
      });

      // Handle non-text messages with placeholders
      const storeNonText = (
        ctx: {
          chat: { id: number; type: string; title?: string };
          message: { date: number; message_id: number; caption?: string };
          from?: { id?: number; first_name?: string; username?: string };
        },
        placeholder: string,
      ) => {
        const platformId = `telegram:${ctx.chat.id}`;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName = ctx.from?.first_name || ctx.from?.username || ctx.from?.id?.toString() || 'Unknown';
        const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

        config.onMetadata(platformId, undefined, isGroup);
        config.onInbound(platformId, null, {
          id: ctx.message.message_id.toString(),
          kind: 'chat',
          content: {
            text: `${placeholder}${caption}`,
            sender: senderName,
            senderId: `telegram:${ctx.from?.id?.toString() || ''}`,
          },
          timestamp,
          isGroup,
        });
      };

      bot.on('message:photo', (ctx) => storeNonText(ctx as never, '[Photo]'));
      bot.on('message:video', (ctx) => storeNonText(ctx as never, '[Video]'));
      bot.on('message:voice', (ctx) => storeNonText(ctx as never, '[Voice message]'));
      bot.on('message:audio', (ctx) => storeNonText(ctx as never, '[Audio]'));
      bot.on('message:document', (ctx) => {
        const name = (ctx.message.document as { file_name?: string })?.file_name || 'file';
        storeNonText(ctx as never, `[Document: ${name}]`);
      });
      bot.on('message:sticker', (ctx) => {
        const emoji = (ctx.message.sticker as { emoji?: string })?.emoji || '';
        storeNonText(ctx as never, `[Sticker ${emoji}]`);
      });
      bot.on('message:location', (ctx) => storeNonText(ctx as never, '[Location]'));
      bot.on('message:contact', (ctx) => storeNonText(ctx as never, '[Contact]'));

      bot.on('callback_query:data', async (ctx) => {
        const cq = (
          ctx as never as {
            callbackQuery: {
              data: string;
              from: { id: number; first_name?: string };
              message?: { message_id: number };
            };
          }
        ).callbackQuery;
        const msgId: number | undefined = cq.message?.message_id;
        if (msgId === undefined) {
          await (ctx as never as { answerCallbackQuery(): Promise<void> }).answerCallbackQuery().catch(() => {});
          return;
        }

        await (ctx as never as { answerCallbackQuery(): Promise<void> }).answerCallbackQuery().catch(() => {});

        const pending = pendingKeyboards.get(msgId);
        if (!pending) return;
        pendingKeyboards.delete(msgId);

        const numericId = pending.platformId.replace(/^telegram:/, '');
        await bot!.api
          .editMessageText(numericId, msgId, `Chosen: ${cq.data}`, { reply_markup: new InlineKeyboard() })
          .catch(() => {});

        log.info('Keyboard choice responded', { platformId: pending.platformId, msgId, choice: cq.data });

        config.onAction(pending.questionId, cq.data, cq.from.id.toString());
      });

      bot.catch((err) => {
        log.error('Telegram bot error', { err: err.message });
      });

      return new Promise<void>((resolve) => {
        bot!.start({
          onStart: (botInfo) => {
            log.info('Telegram bot connected', { username: botInfo.username, id: botInfo.id });
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(`  Send /chatid to the bot to get a chat's registration ID\n`);
            resolve();
          },
        });
      });
    },

    async teardown(): Promise<void> {
      if (bot) {
        bot.stop();
        bot = null;
        log.info('Telegram bot stopped');
      }
      channelSetup = null;
    },

    isConnected(): boolean {
      return bot !== null;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!bot) {
        log.warn('Telegram bot not initialized');
        return;
      }

      const numericId = platformId.replace(/^telegram:/, '');
      const content = message.content as Record<string, unknown> | null | undefined;

      // ask_question: render as inline keyboard
      if (content && typeof content === 'object' && content.type === 'ask_question') {
        const payload = content as unknown as AskQuestionPayload;
        if (!payload.questionId || !Array.isArray(payload.options)) {
          log.warn('ask_question missing required fields', { platformId });
          return;
        }
        try {
          const keyboard = new InlineKeyboard();
          payload.options.forEach((opt) => keyboard.text(opt.label, opt.value).row());
          const msg = await bot.api.sendMessage(numericId, sanitizeTelegramText(payload.question || payload.title), {
            reply_markup: keyboard,
          });
          pendingKeyboards.set(msg.message_id, {
            platformId,
            questionId: payload.questionId,
          });
          log.info('Telegram ask_question keyboard sent', {
            platformId,
            messageId: msg.message_id,
            questionId: payload.questionId,
          });
        } catch (err) {
          log.error('Failed to send Telegram ask_question keyboard', { platformId, err });
        }
        return;
      }

      // Regular text message
      const text = extractText(message);
      if (!text) return;

      try {
        for (const chunk of splitAtBoundary(text, 4096)) {
          await sendTelegramMessage(bot.api, numericId, chunk);
        }
        log.info('Telegram message sent', { platformId, length: text.length });
      } catch (err) {
        log.error('Failed to send Telegram message', { platformId, err });
      }
      return;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!bot) return;
      try {
        const numericId = platformId.replace(/^telegram:/, '');
        await bot.api.sendChatAction(numericId, 'typing');
      } catch (err) {
        log.debug('Failed to send Telegram typing indicator', { platformId, err });
      }
    },
  };

  return adapter;
}

registerChannelAdapter('telegram', {
  factory() {
    const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    const token = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
      log.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
      return null;
    }
    return createTelegramAdapter(token);
  },
});
