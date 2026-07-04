# NanoClaw Agent-Runner Details

Implementation-level details for the agent-runner inside the container. See [architecture.md](architecture.md) for the high-level design.

## Separation of Concerns

The agent-runner has two layers:

1. **Agent-runner core** — owns the poll loop, message formatting, DB reads/writes, MCP tool implementations, routing, status management, media handling. This is NanoClaw-specific and shared across all providers.

2. **Agent provider** — owns the SDK/runtime interaction. Takes formatted
   prompts, pushes them to the provider, and yields normalized events. Trunk
   registers `claude`, `codex`, `openai-compatible`, and the test-only `mock`
   provider. OpenAI-compatible endpoints (including Ollama) use DB-backed
   profiles; additional native providers may be installed by provider skills.

The boundary: the agent-runner decides **what** to send and **what to do** with results. The provider decides **how** to talk to the SDK.

## AgentProvider Interface

```typescript
interface AgentProvider {
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /** Whether a thrown error invalidates the stored continuation. */
  isSessionInvalid(err: unknown): boolean;

  /** Optional pre-resume transcript rotation/archiving policy. */
  maybeRotateContinuation?(continuation: string, cwd: string): string | null;
}

interface QueryInput {
  /** Initial prompt, already formatted by the runner. */
  prompt: string;

  /** Opaque provider continuation: session/thread/transcript identity. */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /** Provider translates neutral request instructions at its boundary. */
  systemContext?: { instructions?: string };
}

interface AgentQuery {
  /**
   * Push a follow-up message into the active query.
   *
   * The optional acknowledgement must be called only after the provider has
   * produced a result for the turn that consumed the follow-up. The poll loop
   * uses it to mark the corresponding messages_in rows completed.
   */
  push(message: string, onTurnResult?: () => void): void;

  /** Signal that no more input will be sent */
  end(): void;

  /** Output event stream */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query (e.g., container shutting down) */
  abort(): void;
}

type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null; isError?: boolean; usage?: ProviderUsage }
  | {
      type: 'error';
      message: string;
      retryable: boolean;
      classification?: string;
      usage?: ProviderUsage;
      sideEffectBoundaryCrossed?: boolean;
    }
  | { type: 'progress'; message: string }
  | { type: 'activity' };
```

### What the interface does NOT include

- **Message formatting** — the agent-runner formats messages before passing to the provider. The provider receives a ready-to-send prompt string.
- **Provider hooks** — Claude-specific lifecycle and compatibility behavior
  remains inside the Claude provider. Provider-neutral shell execution is a
  NanoClaw MCP capability, not a provider hook.
- **Tool policy** — native providers translate the compiled runtime intent
  into their own policy. Generic profiles receive only verified, compiled
  protocol-tool bindings.
- **Session persistence** — each provider owns the meaning of its opaque
  continuation. The runner stores it in `outbound.db.session_state`, scoped by
  runtime/profile identity.
- **Sandbox configuration** — provider-specific. Each provider configures its own sandbox internally.

### Provider event semantics

- **`init`** — emitted when the provider establishes or resumes state. The
  runner persists the opaque `continuation` immediately.
- **`result`** — emitted when the agent produces a complete response. May be emitted multiple times per query (e.g., Claude's multi-turn with subagents). The agent-runner writes each result to messages_out.
- **`error`** — emitted on failure. `retryable` indicates whether the agent-runner should retry. `classification` is optional detail (e.g., 'quota', 'auth', 'transport').
- **`progress`** — optional, for logging. The agent-runner logs these but doesn't act on them.
- **`activity`** — liveness only; providers emit it for underlying SDK
  activity that is not otherwise a normalized event.

Follow-up acknowledgement is separate from result emission. When the poll loop
finds new inbound rows while a query is active, it marks them `processing`,
calls `provider.push(prompt, ack)`, and leaves them processing until the
provider invokes `ack` after the specific follow-up turn produces a result.
Providers must not call `ack` merely because they accepted or queued the input;
otherwise a dropped provider turn can silently lose a user message.

### Terminal-outcome contract

`processQuery` classifies each initial batch as `result`, `terminal-error`,
`silent-close`, or `interrupted`. Providers must end the initial turn with a
`result` or `error` event. If the stream closes without either, the runner
surfaces a provider error to the user and completes the batch; it never
completes that message silently. A host stop or runner-command interruption
does not produce a user-visible provider error because recovery belongs to the
outer loop and host sweep.

## Provider Implementations

The `claude`, `codex`, `openai-compatible`, and test-only `mock` providers are
registered in `container/agent-runner/src/providers/index.ts`. The OpenCode
section below is an illustrative adapter sketch for provider skills, not
shipped runtime behavior.

### Claude Provider

Wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.

```typescript
class ClaudeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    const stream = new MessageStream(); // AsyncIterable<SDKUserMessage>
    stream.push(input.prompt);

    const sdkQuery = query({
      prompt: stream,
      options: {
        cwd: input.cwd,
        resume: input.continuation,
        systemPrompt: input.systemContext?.instructions
          ? { type: 'preset', preset: 'claude_code', append: input.systemContext.instructions }
          : undefined,
        mcpServers: this.mcpServers,
        additionalDirectories: this.additionalDirectories,
        env: this.env,
        allowedTools: NANOCLAW_TOOL_ALLOWLIST,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        hooks: {
          PreCompact: [{ hooks: [preCompactHook] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [sanitizeBashHook] }],
        },
      },
    });

    return {
      push: (msg) => stream.push(msg),
      end: () => stream.end(),
      abort: () => sdkQuery.close(),
      events: translateClaudeEvents(sdkQuery),
    };
  }
}
```

`translateClaudeEvents` is an async generator that maps SDK messages to `ProviderEvent`:

- `message.type === 'system' && message.subtype === 'init'` → `{ type: 'init', continuation: sessionId }`
- `message.type === 'result'` → `{ type: 'result', text }`
- `message.type === 'system' && message.subtype === 'api_retry'` → `{ type: 'error', retryable: true }`
- `message.type === 'system' && message.subtype === 'rate_limit_event'` → `{ type: 'error', retryable: false, classification: 'quota' }`
- `message.type === 'system' && message.subtype === 'task_notification'` → `{ type: 'progress', message }`
- Everything else → logged, not emitted

**Claude-specific features preserved inside the provider:**

- `MessageStream` for async iterable input (push-based)
- SDK continuation persisted immediately on init
- PreCompact hook for transcript archiving
- PreToolUse/PostToolUse hooks for tool-in-flight lifecycle and declared Bash
  timeout tracking
- Full tool allowlist
- `additionalDirectories` for multi-directory access

### Token-efficient shell

The built-in `run_shell` MCP tool is shared by Claude and Codex. It invokes
`rtk rewrite` without a shell, interprets RTK's allow/passthrough/deny/ask
verdict, and only then executes the selected command through Bash in
`/workspace/agent`. Execution defaults to a 120-second timeout, allows at most
600 seconds, and captures at most 256 KiB by default. Timeout termination
targets the command process group, and tool-in-flight state is always cleared
in a `finally` path.

RTK analytics and tee recovery files are persisted in the agent group's
`.rtk/` directory. Claude's native Bash hook remains enabled as a compatibility
fallback. Provider-native file tools do not pass through RTK.

### Codex Provider

Spawns a `codex app-server` subprocess and drives it over JSON-RPC on stdio — it does **not** wrap an in-process SDK. The transport and protocol live in `codex-app-server.ts`; `codex.ts` orchestrates threads and turns on top of it.

```typescript
class CodexProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    // (simplified — see container/agent-runner/src/providers/codex.ts)
    async function* gen(): AsyncGenerator<ProviderEvent> {
      // 1. Write codex config.toml (MCP servers, model, reasoning effort)
      writeCodexConfigToml(this.mcpServers, { model, effort });

      // 2. Spawn `codex app-server --listen stdio://` and wire auto-approval
      const server = spawnCodexAppServer();
      attachCodexAutoApproval(server);
      await initializeCodexAppServer(server);

      // 3. Start (or resume) a thread; emit its id as the session id
      const { threadId } = await startOrResumeCodexThread(server, input.continuation);
      yield { type: 'init', continuation: threadId };

      // 4. Run a turn per prompt; map app-server notifications → ProviderEvent
      for await (const prompt of prompts) {
        const turnId = await startCodexTurn(server, threadId, prompt);
        // ... await turn-complete / item notifications, yield 'result' / 'error'
      }
    }
    // push() queues another turn; abort() interrupts the active turn and kills
    // the app-server.
  }
}
```

JSON-RPC helpers (`spawnCodexAppServer`, `initializeCodexAppServer`, `startOrResumeCodexThread`, `startCodexTurn`, `steerCodexTurn`, `interruptCodexTurn`, `killCodexAppServer`) are injected as `CodexRuntimeDeps`, which keeps the provider unit-testable.

**Codex-specific behavior inside the provider:**

- App-server subprocess lifecycle (spawn on first query, kill on abort)
- JSON-RPC over stdio (no in-process SDK)
- Config written to `config.toml` (MCP servers, model, reasoning effort)
- Server-side thread/turn state — resume by thread id (`input.continuation`)
- Follow-up messages are queued as explicit turns. The provider no longer
  steers follow-ups into the current turn because Codex can no-op a late steer
  after turn completion; explicit turns give the poll loop a reliable
  acknowledgement point.
- Auto-approval handler for the app-server's permission requests
- Stale-thread detection (`STALE_THREAD_RE` / `isSessionInvalid`)
- Opt-in to the runner's persistent `memory/` scaffold (Codex has no native NanoClaw memory)

### OpenCode Provider (illustrative, not shipped)

Wraps `@opencode-ai/sdk`.

```typescript
class OpenCodeProvider implements AgentProvider {
  query(input: QueryInput): AgentQuery {
    // OpenCode runs a local server — create it once, reuse across queries
    const { client, server } = await createOpencode({ config: this.buildConfig(input) });
    const { stream } = await client.event.subscribe();

    let aborted = false;
    let pendingFollowUp: string | null = null;

    return {
      push: (msg) => {
        pendingFollowUp = msg;
        server.close(); // interrupt current query
      },
      end: () => {
        /* no-op */
      },
      abort: () => {
        aborted = true;
        server.close();
      },
      events: this.run(client, server, stream, input, () => pendingFollowUp),
    };
  }

  private async *run(client, server, stream, input, getPendingFollowUp): AsyncIterable<ProviderEvent> {
    const session = await client.session.create();
    yield { type: 'init', continuation: session.data.id };

    await client.session.promptAsync({
      path: { id: session.data.id },
      body: { parts: [{ type: 'text', text: input.prompt }] },
    });

    for await (const event of stream) {
      if (event.type === 'session.idle') {
        // Collect result text from accumulated message parts
        const resultText = this.extractResult(event);
        yield { type: 'result', text: resultText };

        const followUp = getPendingFollowUp();
        if (followUp) {
          await client.session.promptAsync({
            path: { id: session.data.id },
            body: { parts: [{ type: 'text', text: followUp }] },
          });
          continue;
        }

        return;
      }

      if (event.type === 'session.error') {
        yield { type: 'error', message: event.properties?.error?.data?.message, retryable: false };
        return;
      }
    }
  }
}
```

**OpenCode-specific behavior inside the provider:**

- Local gRPC/HTTP server lifecycle (`server.close()`)
- SSE event stream for output
- Provider/model selection via config (`OPENCODE_PROVIDER`, `OPENCODE_MODEL`)
- MCP config format translation (`type: 'local'`, `command: [cmd, ...args]`, `environment`)
- System prompt injected via `<system>` prefix in prompt text
- No resume support (sessions are always new or reused by ID)

## Agent-Runner Core

Everything below is handled by the agent-runner, not the provider.

### Generic protocol tool loop

An OpenAI-compatible profile is text-only unless its endpoint/model fingerprint
has passed host-side tool verification. For a verified profile, the host embeds
compiled `tool:` bindings in `sessionRuntimePlan`. Runner startup resolves only
those bindings against the in-process NanoClaw MCP catalog.

The provider normalizes Responses and Chat Completions function calls, validates
arguments, executes calls sequentially, suppresses duplicate call IDs, appends
correlated tool results, and continues for at most eight iterations with at
most eight calls per iteration. Duplicate suppression resets for each provider
turn, and the complete normalized result is capped at 64 KiB. Unknown,
ungranted, malformed, handler-failed, and limit-exceeded calls produce one
terminal `tool_unauthorized`, `tool_invalid`, `tool_execution`, or
`tool_loop_limit` error. Aborting during one call cannot start a later call.
External MCP discovery, parallel execution, and provider-built-in tools are
not part of this loop.

### Poll Loop

```
┌─────────────────────────────────────────┐
│                                         │
│  1. Query messages_in for pending rows  │
│     WHERE status = 'pending'            │
│     AND (process_after IS NULL          │
│          OR process_after <= now())     │
│                                         │
│  2. If rows found:                      │
│     a. Set status = 'processing'        │
│     b. Format messages by kind          │
│     c. Strip routing fields             │
│     d. Call provider.query(prompt)      │
│     e. Process provider events          │
│     f. Write results to messages_out    │
│     g. Set status = 'completed'         │
│                                         │
│  3. While query is active:              │
│     - Continue polling messages_in      │
│     - New messages → provider.push(ack) │
│                                         │
│  4. When query finishes:                │
│     - Back to step 1                    │
│     - If no messages, sleep + re-poll   │
│                                         │
└─────────────────────────────────────────┘
```

**Concurrent polling during active query:** While the provider is running a query, the agent-runner continues polling messages_in on a short interval (~500ms). New pending messages are marked `processing`, formatted, and pushed into the active query via `provider.push(prompt, ack)`. The poll loop marks those follow-up rows `completed` only when the provider calls `ack` after the follow-up turn produces a result. This lets follow-up messages arrive while the agent is processing without treating "input accepted" as "input processed." Claude handles pushed input through its SDK stream; Codex queues each follow-up as an explicit app-server turn so it has a reliable completion point.

**Idle behavior:** When no messages are pending and no query is active, the agent-runner sleeps briefly (1s) and re-polls. The container stays warm until the host kills it (idle timeout).

**Idle detection exceptions:** The container should NOT be considered idle when:

- An `ask_user_question` tool call is pending (waiting for user response in messages_in)
- The agent is actively working (tool calls in progress, subagents running)

The agent-runner signals "busy" status to the host. The mechanism for this is provider-specific — for Claude, the query AsyncGenerator is still yielding events. For others, the agent-runner can write a heartbeat or status indicator to the session DB that the host checks before killing.

### Message Formatting

The agent-runner transforms messages_in rows into a prompt string. The provider receives a ready-to-send string — it doesn't know about message kinds or routing.

**Routing field stripping:** `platform_id`, `channel_type`, `thread_id` are never included in the prompt. They're stored as context for writing messages_out.

**Single message formatting by kind:**

- **`chat`** — format into message XML:

  ```xml
  <message sender="John" time="2024-01-01 10:00">
    Check this PR
  </message>
  ```

- **`chat-sdk`** — extract fields from serialized Chat SDK message:

  ```xml
  <message sender="John (john@slack)" time="2024-01-01 10:00">
    Check this PR
    [image: screenshot.png — https://signed-url...]
  </message>
  ```

  Attachments are listed inline. Images/PDFs that Claude handles natively are passed as content blocks (see Media Handling below).

- **`task`** — task prompt, optionally with script output:

  ```
  [SCHEDULED TASK]

  Script output:
  {"data": ...}

  Instructions:
  Review open PRs
  ```

- **`webhook`** — webhook payload:

  ```
  [WEBHOOK: github/pull_request]

  {"action": "opened", "pull_request": {...}}
  ```

- **`system`** — host action result (response to an earlier system request):

  ```
  [SYSTEM RESPONSE]

  Action: create_agent
  Status: success
  Result: {"agent_group_id": "ag-456"}
  ```

**Batch formatting:** Multiple pending messages are combined into one prompt:

```xml
<context timezone="America/Los_Angeles">
<messages>
<message sender="John" time="10:00">Check this PR</message>
<message sender="Jane" time="10:01">Already on it</message>
</messages>
```

Mixed kinds (e.g., a chat message + a system response) are combined with clear delimiters. Each section is labeled by kind.

**Command detection:** Messages starting with `/` are checked against a command list. Recognized commands bypass formatting and are passed raw to the provider (for Claude's slash command handling) or intercepted by the agent-runner (for NanoClaw-level commands like session reset).

### Routing

When the agent-runner picks up messages_in rows, it captures the routing fields from the batch:

```typescript
interface RoutingContext {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  inReplyTo: string | null; // messages_in.id of the triggering message
}
```

When writing messages_out (either from provider results or MCP tool calls), the agent-runner copies this routing context by default. The agent never sees routing fields — it just produces text. The routing is implicit: "respond to whoever sent the message."

MCP tools that target a different destination (e.g., `send_to_agent`, `send_message` with explicit channel) override the routing context for that specific messages_out row.

### Status Management

The agent-runner manages message lifecycle through `processing_ack` rows in
`outbound.db`; the host syncs those rows back to `messages_in.status`:

```
pending → processing → completed
                    → failed (if provider returns error and max retries exhausted)
```

- **Pick up:** container writes `processing_ack(status='processing')`
- **Complete:** container writes `processing_ack(status='completed')`
- **Error:** agent-runner normally leaves the message as `processing`. The host detects stale processing via `processing_ack.status_changed` and handles retry logic (reset to pending with backoff). This keeps retry policy on the host side.

### MCP Tools

The agent-runner runs an MCP server that exposes NanoClaw tools to the agent. All tools write to the session DB.

**DB paths:** The MCP server is a separate stdio process (spawned by the provider via `mcpServers` config). It reaches the session DBs through the same connection layer (`db/connection.ts`) — `inbound.db` read-only, `outbound.db` read-write. Tools write their output as `messages_out` rows on `outbound.db`.

#### send_message

Send a chat message to the current conversation (or a specified destination).

```typescript
{
  name: 'send_message',
  params: {
    text: string,          // message content
    channel?: string,      // optional: target channel type (default: reply to origin)
    platformId?: string,   // optional: target platform ID
    threadId?: string,     // optional: target thread ID
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat'`. If channel/platformId/threadId are provided, use those as routing. Otherwise, copy from the current routing context.

#### send_file

Send a file to the current conversation.

```typescript
{
  name: 'send_file',
  params: {
    path: string,          // file path (relative to /workspace/agent/ or absolute)
    text?: string,         // optional accompanying message
    filename?: string,     // display name (default: basename of path)
  }
}
```

Implementation:

1. Generate a message ID
2. Create `outbox/{messageId}/` directory
3. Copy the file into the outbox directory
4. Write a `messages_out` row with `files: [filename]` in the content

#### send_card

Send a structured card (interactive or display-only).

```typescript
{
  name: 'send_card',
  params: {
    card: CardElement,     // card structure (title, children, actions)
    fallbackText?: string, // text fallback for platforms without card support
  }
}
```

Implementation: write a `messages_out` row with `kind: 'chat-sdk'` and the card structure in content.

#### ask_user_question

Send an interactive question and wait for the user's response. This is a **blocking tool call** — the tool doesn't return until the user responds.

```typescript
{
  name: 'ask_user_question',
  params: {
    title: string,         // short card title, e.g. "Confirm deletion"
    question: string,
    options: (string | { label: string; selectedLabel?: string; value?: string })[],
    timeout?: number,      // seconds (default: 300)
  }
}
```

Implementation:

1. Generate a `questionId`
2. Write a `messages_out` row with `operation: 'ask_question'`, the question, options, and questionId
3. Poll `messages_in` for a row with matching `questionId` in content
4. When found, return the `selectedOption` as the tool result
5. If timeout expires, return a timeout error as the tool result

The agent's execution is paused at this tool call. The provider's query keeps running (Claude holds the tool call open). The agent-runner polls for the response in a separate loop.

#### edit_message

Edit a previously sent message.

```typescript
{
  name: 'edit_message',
  params: {
    messageId: string,     // integer ID as shown to the agent
    text: string,          // new content
  }
}
```

Implementation: write a `messages_out` row with `operation: 'edit'`, the message ID, and new text.

#### add_reaction

Add an emoji reaction to a message.

```typescript
{
  name: 'add_reaction',
  params: {
    messageId: string,     // integer ID as shown to the agent
    emoji: string,         // emoji name (e.g., 'thumbs_up')
  }
}
```

Implementation: write a `messages_out` row with `operation: 'reaction'`.

#### send_to_agent

Send a message to another agent group.

```typescript
{
  name: 'send_to_agent',
  params: {
    agentGroupId: string,  // target agent group
    text: string,          // message content
    sessionId?: string,    // optional: target specific session
  }
}
```

Implementation: write a `messages_out` row with `channel_type: 'agent'`, `platform_id: agentGroupId`, `thread_id: sessionId`.

#### schedule_task

Schedule a one-shot or recurring task.

```typescript
{
  name: 'schedule_task',
  params: {
    prompt: string,             // task prompt
    processAfter: string,       // ISO timestamp for first run
    recurrence?: string,        // cron expression (optional)
    script?: string,            // pre-agent script (optional)
  }
}
```

Implementation: write a `messages_in` row (to self) with `kind: 'task'`, `process_after`, and optionally `recurrence`. The host sweep picks it up when due.

#### list_tasks

List active scheduled/recurring tasks.

```typescript
{
  name: 'list_tasks',
  params: {}
}
```

Implementation: query `messages_in WHERE recurrence IS NOT NULL AND status != 'failed'`.

#### cancel_task / pause_task / resume_task / update_task

Modify a scheduled task.

```typescript
{
  name: 'cancel_task',
  params: { taskId: string }
}
// pause_task: set status = 'paused' (new status value for recurring tasks)
// resume_task: set status = 'pending'
// update_task: merge { prompt?, recurrence?, processAfter?, script? } into the live row
```

Implementation: cancel/pause/resume update the live row(s) directly. update_task is sent as a system action — the host reads current content, merges supplied fields, and writes back. All four match by `(id = ? OR series_id = ?) AND kind='task' AND status IN ('pending','paused')`, so they reach the live next occurrence of a recurring task even when the agent passes the original (now-completed) id.

#### create_agent

Create a long-lived companion sub-agent (admin only). The new agent's name becomes a destination for the caller.

```typescript
{
  name: 'create_agent',
  params: {
    name: string,            // human-readable name (also the destination name)
    instructions?: string,   // CLAUDE.md content for the new agent (optional)
  }
}
```

Implementation: write a `messages_out` row with `kind: 'system'`, `action: 'create_agent'`. The host reads, validates admin permission, creates the entity rows in the central DB, wires the new agent as a destination, and writes a `system` messages_in response. Non-admin containers never see this tool.

#### Durable agent task tools

`request_agent_task`, `get_agent_task`, and `cancel_agent_task` are requester operations. Assigned task prompts direct the target to use `report_agent_task_progress`, `block_agent_task`, `complete_agent_task`, `fail_agent_task`, and `publish_agent_task_artifact`. Every tool writes a typed `system` action; it does not mutate the central DB directly.

The runner formats assignments as `<agent_task>`, correlated updates as `<agent_task_event>`, and cancellations as `<agent_task_cancel>`. The host derives actor identity from the source session and enforces ownership, destination authorization, target capability compatibility, terminal-state monotonicity, and artifact policy. These tools are available through native MCP and through compiled protocol-tool bindings on verified generic profiles.

### Media Handling

#### Inbound (messages_in → agent prompt)

The host decodes attachment data into
`/workspace/inbox/<message-id>/<filename>` before writing the inbound content.
The runner formats each attachment as a text reference to that local path:

```
<message sender="John" time="10:00">
  Check this spreadsheet
  [file: data.xlsx — saved to /workspace/inbox/msg-123/data.xlsx]
</message>
```

`QueryInput.prompt` is currently a string for every provider. The acting
runtime can inspect the mounted file with its granted native tools. The runner
does not currently construct provider-native image/PDF/audio content blocks.

#### Outbound (agent → messages_out)

Handled via the `send_file` MCP tool (see above). The agent explicitly decides to send a file — the agent-runner doesn't scan output for file references.

### Pre-Agent Scripts (Tasks)

For `task` kind messages with a `script` field in the content:

1. Agent-runner writes the script to a temp file
2. Executes with `bash` (30s timeout)
3. Parses last line of stdout as JSON: `{ wakeAgent: boolean, data?: unknown }`
4. If `wakeAgent === false`: mark message as completed, don't invoke the provider
5. If `wakeAgent === true`: enrich the prompt with script output, then invoke the provider

### Transcript Archiving

Claude can archive its on-disk transcript when continuation rotation decides
that the transcript is too large or old to cold-resume safely. That behavior
is provider-specific. Codex owns thread state in app-server storage; the
generic protocol loop persists a bounded normalized transcript in
`outbound.db.session_state`. The runner does not synthesize a common Markdown
archive after every provider query.

### Session Resume

The runner captures `ProviderEvent { type: 'init', continuation }` and writes
the opaque continuation immediately to `outbound.db.session_state`. Keys are
scoped by provider/profile runtime identity, so switching profiles cannot
resume another endpoint's state. On the next query or container process, the
runner passes the value as `QueryInput.continuation`.

Claude interprets it as an SDK session ID, Codex as an app-server thread ID,
and the generic protocol loop uses its own bounded transcript state. The
central `sessions` table does not store provider continuation IDs.

### Container Startup

The agent-runner receives configuration via:

- **Container config file:** The runner reads `/workspace/agent/container.json` at startup (`config.ts`). The host mounts a session-specific runtime file at that path; it holds the effective provider/profile, assistant name, group name, agent group id, MCP server configs, model/effort overrides, state key, and neutral agent profile. The similarly named group-workspace file is an operator snapshot, not the final session override.
- **Environment variables:** `NANOCLAW_ADMIN_USER_IDS` (admin sender allowlist, see `formatter.ts`), provider-specific vars (API keys, model overrides), `TZ`.
- **Fixed mount paths:** The session folder is mounted at `/workspace`, containing two separate SQLite files — `inbound.db` (host writes, container opens **read-only**) and `outbound.db` (container writes, host opens read-only) — plus `outbox/` and the `.heartbeat` file. Agent group folder at `/workspace/agent/`. System prompt from `/workspace/agent/CLAUDE.md` and `/workspace/global/CLAUDE.md`.

The agent-runner reads config, creates the provider, and enters the poll loop. No stdin, no initial prompt — messages are already in the session DB.

### Provider Factory

```typescript
type ProviderName = 'claude' | string;

function createProvider(name: ProviderName, config: ProviderConfig): AgentProvider {
  // Trunk registers 'claude' and 'codex'; additional providers self-register when installed via skills.
  const factory = providerRegistry.get(name);
  if (!factory) throw new Error(`Unknown provider: ${name}`);
  return factory(config);
}
```

The provider name comes from the `provider` field of `/workspace/agent/container.json` (read by `config.ts` as `raw.provider`, defaulting to `claude`). The host resolves provider profiles and legacy group/session provider settings before materializing that session runtime file — it is **not** passed as an `AGENT_PROVIDER` environment variable.

Provider-specific settings (model, reasoning effort, MCP servers) also come from `container.json`. Credentials are injected per-request by the OneCLI gateway rather than read from `container.json`.

## Agent-Runner Properties

- Native providers receive only capability-authorized configured MCP servers;
  the NanoClaw server runs with Bun and filters its catalog using the
  materialized session plan. Verified generic profiles execute the same
  registered canonical handlers through the in-process protocol-tool broker
  instead of MCP discovery.
- Provider-native project docs are loaded by their native runtimes. The host
  also materializes bounded request-level system instructions in runtime
  config where required.
- Additional directories discovery (`/workspace/extra/*`)
- Logging via stderr (`[agent-runner] ...`)

## Related Documents

- **[architecture.md](architecture.md)** — High-level architecture (session DB schema, central DB, channel adapters, message flow)
- **[api-details.md](api-details.md)** — Channel adapter interface, message content examples, host delivery logic
