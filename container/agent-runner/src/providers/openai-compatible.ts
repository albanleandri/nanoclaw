import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  ProviderStateStore,
  QueryInput,
} from './types.js';
import { readProtocolIteration, toolResultItems, toolSchemasForFamily } from '../tool-loop/openai-wire.js';
import { ProtocolToolError } from '../tool-loop/types.js';
import type { ProviderUsage } from './types.js';
import { normalizeProviderUsage } from './usage.js';

interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

const TRANSCRIPT_KEY = 'transcript-v1';
const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_TURNS = 20;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
const MAX_TOOL_ITERATIONS = 8;
const MAX_TOOL_CALLS_PER_ITERATION = 8;

function loadTranscript(store: ProviderStateStore): TranscriptMessage[] {
  try {
    const parsed = JSON.parse(store.get(TRANSCRIPT_KEY) ?? '[]') as TranscriptMessage[];
    return Array.isArray(parsed) ? parsed.filter((item) => item?.role && typeof item.content === 'string') : [];
  } catch {
    return [];
  }
}

function saveTranscript(store: ProviderStateStore, messages: TranscriptMessage[]): void {
  let bounded = messages.slice(-MAX_TRANSCRIPT_TURNS * 2);
  while (bounded.length > 0 && Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_TRANSCRIPT_BYTES) {
    bounded = bounded.slice(2);
  }
  store.set(TRANSCRIPT_KEY, JSON.stringify(bounded));
}

function endpoint(baseUrl: string, family: 'responses' | 'chat-completions'): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = family === 'responses' ? '/responses' : '/chat/completions';
  return base.endsWith(suffix) ? base : `${base}${suffix}`;
}

function classifyError(status: number, body: string): { classification: string; retryable: boolean } {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) return { classification: 'auth', retryable: false };
  if (lower.includes('quota') || lower.includes('billing') || lower.includes('insufficient_quota')) {
    return { classification: 'quota', retryable: false };
  }
  if (status === 429) return { classification: 'rate_limit', retryable: true };
  if (lower.includes('context_length') || lower.includes('maximum context') || lower.includes('token limit')) {
    return { classification: 'context', retryable: false };
  }
  if (status >= 500) return { classification: 'transient', retryable: true };
  return { classification: 'invalid_request', retryable: false };
}

function extractJsonText(family: 'responses' | 'chat-completions', value: unknown): string {
  const data = value as Record<string, any>;
  if (family === 'chat-completions') return data.choices?.[0]?.message?.content ?? '';
  if (typeof data.output_text === 'string') return data.output_text;
  return (data.output ?? [])
    .flatMap((item: any) => item.content ?? [])
    .map((item: any) => item.text ?? '')
    .join('');
}

async function* readStreamingEvents(
  response: Response,
  family: 'responses' | 'chat-completions',
): AsyncGenerator<{ type: 'activity' } | { type: 'text'; text: string } | { type: 'usage'; usage: ProviderUsage }> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emittedText = false;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    yield { type: 'activity' };
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const event = JSON.parse(payload) as Record<string, any>;
      if (family === 'chat-completions') {
        const usage = normalizeProviderUsage(event.usage);
        if (usage) yield { type: 'usage', usage };
        const text = event.choices?.[0]?.delta?.content ?? '';
        if (text) {
          emittedText = true;
          yield { type: 'text', text };
        }
      } else if (event.type === 'response.output_text.delta') {
        if (event.delta) {
          emittedText = true;
          yield { type: 'text', text: event.delta };
        }
      } else if (event.type === 'response.completed') {
        const usage = normalizeProviderUsage(event.response?.usage);
        if (usage) yield { type: 'usage', usage };
        if (!emittedText) {
          const text = extractJsonText(family, event.response);
          if (text) yield { type: 'text', text };
        }
      }
    }
  }
}

export class OpenAICompatibleProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  readonly memoryDeliveryMode = 'per-logical-request' as const;
  private readonly options: ProviderOptions;

  constructor(options: ProviderOptions) {
    this.options = options;
    if (!options.providerProfile?.baseUrl || !options.providerProfile.apiFamily) {
      throw new Error('openai-compatible requires a provider profile with baseUrl and apiFamily');
    }
    if (!options.model) throw new Error('openai-compatible requires a model');
    if (!options.stateStore) throw new Error('openai-compatible requires a provider state store');
    if (options.providerProfile.toolStrategy === 'native' && !options.protocolToolBroker?.list().length) {
      throw new Error('tool-enabled openai-compatible profile requires compiled protocol tools');
    }
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: Array<{ prompt: string; ack?: () => void }> = [{ prompt: input.prompt }];
    let wake: (() => void) | undefined;
    let ended = false;
    let activeController: AbortController | undefined;
    let aborted = false;
    const options = this.options;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        while (!ended || pending.length > 0) {
          if (pending.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            continue;
          }
          const turn = pending.shift()!;
          const transcript = loadTranscript(options.stateStore!);
          let terminalError: Extract<ProviderEvent, { type: 'error' }> | undefined;
          let resultText = '';
          let usage: ProviderUsage | undefined;
          let sideEffectBoundaryCrossed = false;
          const family = options.providerProfile!.apiFamily!;
          const memoryContext = options.memory?.enabled ? options.memory.render() : '';
          const broker = options.providerProfile!.toolStrategy === 'native' ? options.protocolToolBroker : undefined;
          broker?.resetTurn?.();
          const continuationItems: unknown[] = [];
          for (let iteration = 0; iteration < (broker ? MAX_TOOL_ITERATIONS : 1); iteration++) {
            let response: Response | undefined;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
              const controller = new AbortController();
              activeController = controller;
              const timeout = setTimeout(
                () => controller.abort(new Error('Provider request timed out')),
                options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
              );
              try {
                const messages = [
                  ...(input.systemContext?.instructions || memoryContext
                    ? [
                        {
                          role: 'system',
                          content: [input.systemContext?.instructions, memoryContext].filter(Boolean).join('\n\n'),
                        },
                      ]
                    : []),
                  ...transcript,
                  { role: 'user', content: turn.prompt },
                  ...continuationItems,
                ];
                const tools = broker ? toolSchemasForFamily(family, broker.list()) : undefined;
                const body =
                  family === 'responses'
                    ? { model: options.model, input: messages, stream: true, ...(tools ? { tools } : {}) }
                    : { model: options.model, messages, stream: true, ...(tools ? { tools } : {}) };
                const headers: Record<string, string> = { 'content-type': 'application/json' };
                if (options.providerProfile!.authMode !== 'none') headers.authorization = 'Bearer placeholder';
                response = await (options.httpFetch ?? fetch)(endpoint(options.providerProfile!.baseUrl!, family), {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(body),
                  signal: controller.signal,
                  redirect: 'error',
                });
                yield { type: 'activity' };
                if (!response.ok) {
                  const errorBody = (await response.text()).slice(0, 4096);
                  const classified = classifyError(response.status, errorBody);
                  if (classified.retryable && attempt < MAX_ATTEMPTS) continue;
                  terminalError = {
                    type: 'error',
                    message: `Provider request failed (${response.status})`,
                    retryable: false,
                    classification: classified.classification,
                  };
                  response = undefined;
                }
                break;
              } catch (error) {
                if (aborted) return;
                if (attempt < MAX_ATTEMPTS) continue;
                terminalError = {
                  type: 'error',
                  message: error instanceof Error ? error.message : 'Provider transport failed',
                  retryable: false,
                  classification: 'transient',
                };
              } finally {
                clearTimeout(timeout);
                if (activeController === controller) activeController = undefined;
              }
            }
            if (terminalError || !response) break;
            if (!broker) {
              const contentType = response.headers.get('content-type') ?? '';
              if (contentType.includes('text/event-stream')) {
                for await (const event of readStreamingEvents(response, family)) {
                  if (event.type === 'activity') yield { type: 'activity' };
                  else if (event.type === 'text') resultText += event.text;
                  else usage = event.usage;
                }
              } else {
                const value = await response.json();
                resultText = extractJsonText(family, value);
                usage = normalizeProviderUsage((value as Record<string, unknown>).usage);
              }
              break;
            }
            try {
              const protocol = await readProtocolIteration(response, family);
              if (protocol.kind === 'text') {
                resultText = protocol.text;
                break;
              }
              if (protocol.calls.length > MAX_TOOL_CALLS_PER_ITERATION) {
                throw new ProtocolToolError('Provider exceeded tool call limit', 'tool_loop_limit');
              }
              if (protocol.calls.length > 0) sideEffectBoundaryCrossed = true;
              const results = [];
              for (const call of protocol.calls) {
                if (aborted) return;
                yield { type: 'activity' };
                if (aborted) return;
                results.push(await broker.execute(call));
                if (aborted) return;
              }
              continuationItems.push(...protocol.continuationItems, ...toolResultItems(family, results));
            } catch (error) {
              terminalError = {
                type: 'error',
                message: error instanceof Error ? error.message : 'Protocol tool loop failed',
                retryable: false,
                classification: error instanceof ProtocolToolError ? error.classification : 'tool_execution',
              };
              break;
            }
            if (iteration === MAX_TOOL_ITERATIONS - 1) {
              terminalError = {
                type: 'error',
                message: 'Provider exceeded tool iteration limit',
                retryable: false,
                classification: 'tool_loop_limit',
              };
            }
          }
          if (terminalError) {
            yield { ...terminalError, sideEffectBoundaryCrossed };
            return;
          }
          if (!resultText.trim()) {
            yield {
              type: 'error',
              message: 'Provider stream ended without a result',
              retryable: false,
              classification: 'invalid_request',
            };
            return;
          }
          transcript.push({ role: 'user', content: turn.prompt }, { role: 'assistant', content: resultText });
          saveTranscript(options.stateStore!, transcript);
          turn.ack?.();
          yield { type: 'result', text: resultText, usage };
        }
      },
    };

    return {
      events,
      push(message, onTurnResult) {
        pending.push({ prompt: message, ack: onTurnResult });
        wake?.();
      },
      end() {
        ended = true;
        wake?.();
      },
      abort() {
        ended = true;
        aborted = true;
        activeController?.abort();
        wake?.();
      },
    };
  }
}

registerProvider('openai-compatible', (options) => new OpenAICompatibleProvider(options));
