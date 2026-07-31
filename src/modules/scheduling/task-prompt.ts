/**
 * The delivery contract baked into every task prompt.
 *
 * A task fires into an isolated `system:tasks:<series>` session with no chat
 * attached. One-door delivery (D3) means the ONLY thing that reaches a human
 * from that run is a `send_message` call naming an explicit destination —
 * final text and `<message>` blocks are inert there, and the final text is
 * instead auto-appended to the series run log. An agent that does not know
 * this schedules a reminder that fires, produces text, and delivers nothing.
 *
 * Both task creation paths must therefore attach it:
 *   - `ncl tasks create`               → src/cli/resources/tasks.ts
 *   - the `schedule_task` system action → ./schedule-action.ts (D4, the
 *     openai-protocol-loop shim, whose agents have no `ncl` to learn it from)
 *
 * It lives here, in a module that imports nothing, so both callers can reach
 * it: src/cli/resources/tasks.ts already imports from this directory, and the
 * reverse import would be a cycle.
 */

/**
 * Append the delivery contract for `seriesId` to a task prompt.
 *
 * The series id appears three times because the agent needs it as a path
 * (`tasks/<id>.md`) to read prior runs, to know what is being auto-written,
 * and to know not to hand-edit it.
 */
export function withTaskDeliveryContract(prompt: string, seriesId: string): string {
  return (
    `${prompt}\n\n` +
    `[Task delivery contract:\n` +
    `• MESSAGE (only if the task asks you to report/notify): use send_message({ to: "name", … }) with an explicit destination — that tool call is the ONLY thing the user receives. This run has no chat attached: final text and <message> blocks are NOT delivered here.\n` +
    `• RUN LOG (automatic): your final text is recorded verbatim in tasks/${seriesId}.md — end the run with a concrete work-log line: what you did and WHY (a no-op run still ends with why nothing was needed; name any files you wrote). Not a greeting, not a copy of the message you sent. For extra mid-run notes use \`ncl tasks append-log --msg "…"\` — if you do, your final text is not auto-logged. Do NOT edit tasks/${seriesId}.md by hand; the log never goes to the user.\n` +
    `Need context from past runs? Read tasks/${seriesId}.md first.]`
  );
}
