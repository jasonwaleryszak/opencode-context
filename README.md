# opencode-context

An OpenCode V2 plugin that adds a `/context` command, a breakdown of what fills the current session's context window, similar to `/context` in Claude Code.

```
Context Usage

▪ ■ ■ ■ ■ ▪ ▪ □ □ □    Claude Opus 5.5
□ □ □ □ □ □ □ □ □ □    opencode/claude-opus-5-5 · high
□ □ □ □ □ □ □ □ □ □    52.1k/200k tokens (26.1%)
□ □ □ □ □ □ □ □ □ □
□ □ □ □ □ □ □ □ □ □    Estimated usage by category
□ □ □ □ □ □ □ □ □ □    Baseline: 16.3k tokens (8.2%)
□ □ □ □ □ □ □ □ □ □      ■ System prompt: 1.2k tokens (0.6%)
□ □ □ □ □ □ □ □ ⊠ ⊠      ■ System tools: 9.4k tokens (4.7%)
⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠      ■ MCP tools: 3.3k tokens (1.7%)
⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠ ⊠      ■ Instructions: 1.1k tokens (0.5%)
                         ■ Skills: 1.3k tokens (0.7%)
                       ■ This thread: 35.8k tokens (17.9%)
                       □ Free space: 117.9k tokens (58.9%)
                       ⊠ Autocompact buffer: 30k tokens (15%)

│ This thread includes 120 tokens from the latest reply, which the model receives with your next message.

Baseline · 16.3k tokens · sent with every request
├ System prompt: 1.2k tokens · agent instructions and environment info
│ └ …
├ System tools: 9.4k tokens · built-in and plugin tools the model can use
│ ├ subagent: 744 tokens
│ ├ edit: 420 tokens
│ ├ opencode: 310 tokens · 8 tools called from scripts (Code Mode)
│ └ Overhead: 359 tokens · how to call tools from scripts (Code Mode)
└ …

This thread · 35.8k tokens · grows with every turn
├ Tool use: 31.4k tokens · 37 calls
│ ├ read: 19.1k tokens · 9 calls
│ ├ shell: 6.6k tokens · 14 calls
│ └ edit: 5.7k tokens · 14 calls · mostly what the model sent
├ Model output: 3.5k tokens
│ ├ Reasoning: 1.9k tokens · the model's thinking before it answers
│ └ Replies: 1.6k tokens
├ Your messages: 480 tokens
└ Formatting: 420 tokens · markup that separates messages

• Overhead: text a category adds once as a whole; removing one tool, server, or skill won't reduce it.
• Autocompact buffer: space kept free so OpenCode can summarize older messages before the window fills up.
```

Each grid cell is 1% of the model's context window. A small square (`▪`) marks a category that fills less than one cell.

Sections and rows keep OpenCode's names for things (MCP, Skills, Code Mode, autocompact), and each one has a short plain-language description next to it. Notes about where the numbers come from appear under the summary. A short glossary at the bottom explains **Overhead** and **Autocompact buffer** when they appear.

- **MCP** (Model Context Protocol): external servers you connect to add tools.
- **Skills**: guides the model can load when needed. Only their summaries are sent until then.
- **Code Mode**: instead of sending every tool's full definition, OpenCode lists short signatures and the model calls those tools by writing a script for its `execute` tool.
- **Autocompact**: when the context fills up to the buffer, OpenCode summarizes older messages to make room.

## What it shows

| Category | Source |
| --- | --- |
| System prompt | Agent prompt, environment, date, model info, and other system text |
| System tools | Definitions (description and input schema) of every tool sent to the model, plus Code Mode catalog entries that don't belong to an MCP server (such as the built-in `opencode` namespace), plus an **Overhead** row for the shared Code Mode guidance |
| MCP tools | One row per configured MCP server, combining its Code Mode catalog entry, tools sent directly, and server instructions, plus an **Overhead** row for the shared `<mcp_instructions>` wrapper. Configured servers that add nothing to the context are listed with 0 tokens and their status (for example `disabled`) |
| Instructions | Each `AGENTS.md` and instruction file, listed by path |
| Skills | Each skill advertised to the model, plus an **Overhead** row for the shared guidance on using skills and the list markup |
| This thread | The conversation: **Tool use** (each tool's calls and results together), **Model output** (replies and reasoning), your messages, attachments, system reminders, the compaction summary that replaced earlier messages, and message formatting |
| Free space | Room left before automatic compaction starts |
| Autocompact buffer | Space reserved by [`compaction.buffer`](https://opencode.ai/v2/docs/compaction/) (15% by default, at least 16k) |

Categories are split into two groups, each shown as one tree. **Baseline** is what every request carries before any conversation (system prompt, tools, MCP tools, instructions, and skills), so it is what a new session starts with. **This thread** is the conversation, which grows every turn. Its tool use is broken down by tool, counting both the call and its result, since both stay in the thread. Edits and writes are mostly in the call. A reply that finished after the latest request is counted in the thread's replies, and a note under the summary says so, because the model receives it with your next message.

Each section is sorted from most to least tokens. The MCP tools and Skills sections always list every server and skill. An **Overhead** row, which is always listed last, counts text that the category adds as a whole and no single tool, server, or skill causes. Removing one of them doesn't reduce it.

The dialog does not add anything to the conversation. Scroll with the arrow keys, PageUp/PageDown, or Home/End, and close it with Esc. The command is also in the command palette as **Show context usage**.

## How it works

- **Server part** (`src/index.ts`) registers a `context` session hook. It keeps a reference to the exact system parts, messages, and tool schemas of each session's most recent model request. OpenCode tags each instruction source (`core/instructions`, `core/skill-guidance`, `core/codemode`, and so on), which lets the plugin attribute tokens to categories and files.
- **Estimates and calibration.** Tokens are first estimated from text length. The plugin then scales them so they usually add up to the prompt size the provider reported for that request (input + cache read + cache write). The scaling is limited, so when the estimate is far off the total differs from the reported size. If provider usage isn't available yet, the dialog says "Approximate usage" instead of "Estimated usage".
- **Fixed costs stay at their initial size.** The system prompt, system tools, MCP tools, instructions, and skills are calibrated once per session, on the thread's first request, so they show what each definition costs per request. A compaction doesn't change that calibration. Whatever else the provider reports as the thread grows (for example encrypted reasoning or dense tool output) goes to **This thread**. If the plugin didn't observe a thread's first request, it calibrates on the first request after the latest compaction, if it observed that one. Otherwise it uses the latest first-request calibration for the same model, or else the plain text-length estimate.
- **RPC.** The server part exposes `opencode-context.breakdown` (`src/rpc.ts`). The TUI part calls it.
- **TUI part** (`src/tui.tsx`) registers the `/context` slash command and renders the dialog.
- **Persistence.** A compact summary of each session's latest breakdown is saved in plugin storage, so `/context` still works after OpenCode restarts. It refreshes with the next message. Up to 200 sessions are kept.
- **New sessions.** A session that hasn't sent anything shows the fixed overhead (system prompt, tools, instructions, skills) from the most recent request in another session, measured against the prompt's selected model.

## Install

Requires OpenCode 2.2.5 or later. The plugin is not published to npm; install it from GitHub:

```sh
opencode plugin add github:jasonwaleryszak/opencode-context
```

This adds the plugin to your global config and installs it. One entry loads both the server part and the TUI part. OpenCode reloads plugins when config changes. Run `/context` in any session.

To pin a release, add a tag or commit, for example `github:jasonwaleryszak/opencode-context#v0.1.0`. Update with `opencode plugin update`.

### From a local clone

To run the plugin from a working copy, for example while developing it, clone the repository and install its dependencies:

```sh
git clone https://github.com/jasonwaleryszak/opencode-context.git
cd opencode-context
npm install
```

Then add the absolute path of the clone to `plugins` in your global `~/.config/opencode/opencode.json`, or in a project's `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/path/to/opencode-context"],
}
```

To update, run `git pull` and `npm install` in the clone.

## Limitations

- Categories come from requests made while the plugin is loaded. For a session that hasn't made a request since then (and has no saved summary), the dialog shows only the provider-reported total until the next message.
- Per-category numbers are estimates. The total usually matches provider-reported usage. Fixed costs use the ratio measured on the thread's first request, and This thread takes the rest. When the estimate is far off, the scaling is limited (between 0.5x and 2.5x overall, and at least 0.5x for This thread), so the total can differ from the reported prompt size.
- Encrypted reasoning returned by some providers is opaque and is not counted separately. Calibration folds it into This thread.
- `instructions` and `skills` parsing relies on the text format of OpenCode's instruction sources (`Instructions from: <path>`, `<skill>` blocks, `<server name="...">` blocks, `- namespace (N tools)` catalog lines). If that format changes, the text is still counted as one item.
- The compaction summary is recognized by the `<conversation-checkpoint>` wrapper OpenCode puts around it. If that format changes, the summary is counted under Your messages.

## Development

```sh
npm install
npm run typecheck
```

## License

MIT. See [LICENSE](LICENSE).
