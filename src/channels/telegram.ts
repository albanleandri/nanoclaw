import https from 'https';
import { Api, Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

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
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
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
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
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
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
  pinnedIndex?: number,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot (caller handles this)
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx =
      pinnedIndex !== undefined
        ? pinnedIndex % poolApis.length
        : nextPoolIndex % poolApis.length;
    if (pinnedIndex === undefined) nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    for (const chunk of splitAtBoundary(text, 4096)) {
      await sendTelegramMessage(api, numericId, chunk);
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export function buildMultiKeyboard(
  options: string[],
  selected: Set<string>,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const opt of options) {
    const label = selected.has(opt) ? `✅ ${opt}` : opt;
    keyboard.text(label, `__opt__:${opt}`).row();
  }
  keyboard.text('Submit', '__submit__').row();
  return keyboard;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private pendingPolls = new Map<
    string,
    { chatJid: string; options: string[] }
  >();
  private pendingKeyboards = new Map<number, { chatJid: string }>();
  private pendingMultiKeyboards = new Map<
    number,
    { chatJid: string; options: string[]; selected: Set<string> }
  >();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.on('poll_answer', (ctx) => {
      const { poll_id, option_ids, user } = (ctx as any).pollAnswer;
      const pending = this.pendingPolls.get(poll_id);
      if (!pending) return;
      this.pendingPolls.delete(poll_id);
      const { chatJid, options } = pending;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      const selected = option_ids.map((i: number) => options[i]).join(', ');
      this.opts.onMessage(chatJid, {
        id: `poll-${poll_id}`,
        chat_jid: chatJid,
        sender: user.id.toString(),
        sender_name: user.first_name || 'User',
        content: `[Poll response: ${selected}]`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });
      logger.info({ chatJid, pollId: poll_id }, 'Poll answer routed to group');
    });

    this.bot.on('callback_query:data', async (ctx) => {
      const cq = (ctx as any).callbackQuery;
      const msgId: number | undefined = cq.message?.message_id;
      if (msgId === undefined) {
        await (ctx as any).answerCallbackQuery().catch(() => {});
        return;
      }

      const multiPending = this.pendingMultiKeyboards.get(msgId);
      if (multiPending) {
        const data = cq.data as string;
        const numericId = multiPending.chatJid.replace(/^tg:/, '');

        if (data === '__submit__') {
          if (multiPending.selected.size === 0) {
            await (ctx as any)
              .answerCallbackQuery({
                text: 'Please select at least one option.',
                show_alert: true,
              })
              .catch(() => {});
            return;
          }
          const selected = [...multiPending.selected].join(', ');
          this.pendingMultiKeyboards.delete(msgId);
          await this.bot!.api
            .editMessageText(numericId, msgId, `Selected: ${selected}`, {
              reply_markup: new InlineKeyboard(),
            })
            .catch(() => {});
          await (ctx as any).answerCallbackQuery().catch(() => {});
          const group = this.opts.registeredGroups()[multiPending.chatJid];
          if (!group) return;
          this.opts.onMessage(multiPending.chatJid, {
            id: `multi-${msgId}`,
            chat_jid: multiPending.chatJid,
            sender: cq.from.id.toString(),
            sender_name: cq.from.first_name || 'User',
            content: `[Poll response: ${selected}]`,
            timestamp: new Date().toISOString(),
            is_from_me: false,
          });
          logger.info(
            { chatJid: multiPending.chatJid, msgId },
            'Multi-keyboard submitted',
          );
        } else if (data.startsWith('__opt__:')) {
          const option = data.slice(8);
          if (multiPending.selected.has(option)) {
            multiPending.selected.delete(option);
          } else {
            multiPending.selected.add(option);
          }
          const newKeyboard = buildMultiKeyboard(
            multiPending.options,
            multiPending.selected,
          );
          await this.bot!.api
            .editMessageReplyMarkup(numericId, msgId, {
              reply_markup: newKeyboard,
            })
            .catch(() => {});
          await (ctx as any).answerCallbackQuery().catch(() => {});
        } else {
          await (ctx as any).answerCallbackQuery().catch(() => {});
        }
        return;
      }

      // Existing single-select path — unchanged
      await (ctx as any).answerCallbackQuery().catch(() => {});
      const pending = this.pendingKeyboards.get(msgId);
      if (!pending) return;
      this.pendingKeyboards.delete(msgId);
      const { chatJid } = pending;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;
      this.opts.onMessage(chatJid, {
        id: `btn-${msgId}`,
        chat_jid: chatJid,
        sender: cq.from.id.toString(),
        sender_name: cq.from.first_name || 'User',
        content: `[Choice: ${cq.data}]`,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      });
      logger.info({ chatJid, msgId }, 'Keyboard choice routed to group');
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      for (const chunk of splitAtBoundary(text, 4096)) {
        await sendTelegramMessage(this.bot.api, numericId, chunk);
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendPoll(
    jid: string,
    question: string,
    options: string[],
    multiple: boolean,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    const numericId = jid.replace(/^tg:/, '');
    try {
      if (multiple) {
        const keyboard = buildMultiKeyboard(options, new Set());
        const msg = await this.bot.api.sendMessage(
          numericId,
          sanitizeTelegramText(question),
          { reply_markup: keyboard },
        );
        this.pendingMultiKeyboards.set(msg.message_id, {
          chatJid: jid,
          options,
          selected: new Set(),
        });
        logger.info(
          { jid, messageId: msg.message_id },
          'Telegram multi-keyboard sent',
        );
      } else {
        const keyboard = new InlineKeyboard();
        options.forEach((opt) => keyboard.text(opt, opt).row());
        const msg = await this.bot.api.sendMessage(
          numericId,
          sanitizeTelegramText(question),
          { reply_markup: keyboard },
        );
        this.pendingKeyboards.set(msg.message_id, { chatJid: jid });
        logger.info(
          { jid, messageId: msg.message_id },
          'Telegram keyboard sent',
        );
      }
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram poll/keyboard');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
