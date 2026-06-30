import { ProtocolToolError, type ProtocolToolCall, type ProtocolToolDefinition } from './types.js';

export type ApiFamily = 'responses' | 'chat-completions';
export type ProtocolIteration =
  | { kind: 'text'; text: string }
  | { kind: 'tool-calls'; calls: ProtocolToolCall[]; continuationItems: unknown[] };

export function toolSchemasForFamily(family: ApiFamily, definitions: ProtocolToolDefinition[]): unknown[] {
  return definitions.map((tool) =>
    family === 'responses'
      ? { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }
      : {
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        },
  );
}

function fromJson(value: any, family: ApiFamily): ProtocolIteration {
  if (family === 'chat-completions') {
    const message = value.choices?.[0]?.message ?? {};
    if (message.tool_calls?.length) {
      return {
        kind: 'tool-calls',
        calls: message.tool_calls.map((call: any) => ({
          id: call.id,
          name: call.function?.name,
          argumentsJson: call.function?.arguments ?? '',
        })),
        continuationItems: [message],
      };
    }
    return { kind: 'text', text: message.content ?? '' };
  }
  const calls = (value.output ?? []).filter((item: any) => item.type === 'function_call');
  if (calls.length) {
    return {
      kind: 'tool-calls',
      calls: calls.map((call: any) => ({
        id: call.call_id,
        name: call.name,
        argumentsJson: call.arguments ?? '',
      })),
      continuationItems: calls,
    };
  }
  const text =
    value.output_text ??
    (value.output ?? [])
      .flatMap((item: any) => item.content ?? [])
      .map((item: any) => item.text ?? '')
      .join('');
  return { kind: 'text', text };
}

export async function readProtocolIteration(response: Response, family: ApiFamily): Promise<ProtocolIteration> {
  if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    return fromJson(await response.json(), family);
  }
  if (!response.body) return { kind: 'text', text: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completedIteration: ProtocolIteration | undefined;
  const calls = new Map<number, { id: string; name: string; argumentsJson: string; native: any }>();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let event: any;
      try {
        event = JSON.parse(payload);
      } catch (error) {
        throw new ProtocolToolError('Malformed provider event JSON', 'tool_invalid', { cause: error });
      }
      if (family === 'chat-completions') {
        text += event.choices?.[0]?.delta?.content ?? '';
        for (const delta of event.choices?.[0]?.delta?.tool_calls ?? []) {
          const current = calls.get(delta.index) ?? { id: '', name: '', argumentsJson: '', native: null };
          current.id ||= delta.id ?? '';
          current.name ||= delta.function?.name ?? '';
          current.argumentsJson += delta.function?.arguments ?? '';
          calls.set(delta.index, current);
        }
      } else if (event.type === 'response.output_text.delta') {
        text += event.delta ?? '';
      } else if (event.type === 'response.completed' && !text) {
        completedIteration = fromJson(event.response, family);
        if (completedIteration.kind === 'text') text += completedIteration.text;
      } else if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        calls.set(event.output_index, {
          id: event.item.call_id,
          name: event.item.name,
          argumentsJson: event.item.arguments ?? '',
          native: event.item,
        });
      } else if (event.type === 'response.function_call_arguments.delta') {
        const current = calls.get(event.output_index);
        if (current) current.argumentsJson += event.delta ?? '';
      } else if (event.type === 'response.function_call_arguments.done') {
        const current = calls.get(event.output_index);
        if (current) current.argumentsJson = event.arguments ?? current.argumentsJson;
      }
    }
  }
  if (calls.size > 0) {
    const ordered = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    for (const call of ordered) {
      if (!call.id || !call.name) throw new ProtocolToolError('Malformed provider tool call', 'tool_invalid');
      try {
        JSON.parse(call.argumentsJson);
      } catch (error) {
        throw new ProtocolToolError('Malformed provider tool arguments', 'tool_invalid', { cause: error });
      }
    }
    return {
      kind: 'tool-calls',
      calls: ordered.map(({ id, name, argumentsJson }) => ({ id, name, argumentsJson })),
      continuationItems:
        family === 'responses'
          ? ordered.map((call) => ({
              type: 'function_call',
              call_id: call.id,
              name: call.name,
              arguments: call.argumentsJson,
            }))
          : [
              {
                role: 'assistant',
                content: null,
                tool_calls: ordered.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.argumentsJson },
                })),
              },
            ],
    };
  }
  if (completedIteration?.kind === 'tool-calls') return completedIteration;
  return { kind: 'text', text };
}

export function toolResultItems(family: ApiFamily, results: Array<{ callId: string; output: string }>): unknown[] {
  return results.map((result) =>
    family === 'responses'
      ? { type: 'function_call_output', call_id: result.callId, output: result.output }
      : { role: 'tool', tool_call_id: result.callId, content: result.output },
  );
}
