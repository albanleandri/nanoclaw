## Interactive prompts

The two tools here solve different problems: `ask_user_question` forces a decision and waits for it; `send_card` displays structured content and moves on.

### Asking a multiple-choice question (`ask_user_question`)

`mcp__nanoclaw__ask_user_question({ title, question, options, multiple?, timeout? })` presents the user with a set of choices and **blocks your turn** until they answer or the timeout expires (default: 300 seconds). With `multiple: false` or omitted, returns the single chosen value. With `multiple: true`, renders checkbox-style toggles plus a Done button and returns selected values as a comma-separated string.

`options` can be plain strings or `{ label, selectedLabel?, value? }` objects:
- `label` — the button text shown before selection
- `selectedLabel` — the text shown on the button *after* selection (useful for confirmations, e.g. `"✓ Confirmed"`)
- `value` — the string returned to you when that option is chosen (defaults to `label`)

Use this when you genuinely cannot proceed without a decision. For free-text input, send a normal message and wait for their reply — don't reach for this tool.

### Structured cards (`send_card`)

`mcp__nanoclaw__send_card({ card, fallbackText? })` renders a structured card and **returns immediately** — it does not pause your turn or collect a response.

`card` supports: `title`, `description`, `children` (strings or objects with a `text` field), and top-level `actions`. Each action needs a non-empty `label` and a `url` that is a web link (http or https, like `https://example.com`), and renders as a link button. Other actions — including a placeholder such as `#` — are dropped before the card is sent, and the tool result tells you how many. `send_card` never renders callback buttons; if you want a button the user can click to answer, use `ask_user_question`, not a fake link. `fallbackText` is the plain-text version used on channels that render cards as text.

Use this for presenting information in a cleaner format than prose: summaries, options the user can read (but you're not waiting on), or results with link buttons. If you need the user to actually *choose* something and return a value, use `ask_user_question` instead.