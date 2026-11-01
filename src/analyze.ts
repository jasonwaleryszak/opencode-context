import { BASELINE, type Category, type CategoryID, type Item } from "./rpc.js"

/** The parts of a `context` hook event this plugin keeps. */
export interface Capture {
  readonly sessionID: string
  readonly at: number
  readonly agent: string
  readonly model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  readonly system: ReadonlyArray<SystemPartLike>
  readonly messages: ReadonlyArray<MessageLike>
  readonly tools: Readonly<Record<string, { readonly description: string; readonly input: unknown }>>
}

export interface SystemPartLike {
  readonly text: string
  readonly metadata?: Record<string, unknown>
}

export interface MessageLike {
  readonly id?: string
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string } & Record<string, any>>
}

export interface McpServer {
  readonly name: string
  /** Connection status reported by OpenCode (`connected`, `disabled`, `failed`, ...). */
  readonly status?: string
}

export interface AnalyzeOptions {
  /**
   * Configured MCP servers, used to attribute tools and instructions to servers. Every server is
   * listed in the breakdown, including those that add nothing to the context.
   */
  readonly mcpServers: readonly McpServer[]
  /** The active agent's own prompt, used to label it in the system prompt breakdown. */
  readonly agentPrompt?: string
}

export interface Analysis {
  readonly categories: readonly Category[]
  /** Sum of every category, before calibration. */
  readonly total: number
}

const LABELS: Record<CategoryID, string> = {
  system: "System prompt",
  tools: "System tools",
  mcp: "MCP tools",
  instructions: "Instructions",
  skills: "Skills",
  messages: "This thread",
  other: "Other",
}

export const CATEGORY_ORDER: readonly CategoryID[] = [
  "system",
  "tools",
  "mcp",
  "instructions",
  "skills",
  "messages",
  "other",
]

/**
 * Rough token estimate. Real tokenizers differ per provider, so totals are later scaled to the
 * provider-reported prompt size. Non-ASCII text (CJK, emoji) tokenizes far denser than English.
 */
export function estimate(text: string): number {
  if (!text) return 0
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.5)
}

const SKIPPED_KEYS = new Set(["providerMetadata", "metadata", "cache", "native", "providerExecuted"])

/** JSON for estimation only: drops provider bookkeeping and never serializes binary or base64 payloads. */
function stringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (key, inner) => {
        if (SKIPPED_KEYS.has(key)) return undefined
        if (inner instanceof Uint8Array || inner instanceof ArrayBuffer) return "[binary]"
        if (key === "data" && typeof inner === "string" && inner.length > 512) return "[data]"
        return inner
      }) ?? ""
    )
  } catch {
    return ""
  }
}

function estimateMedia(part: Record<string, any>): number {
  const info = part.media?.info ?? part.info
  const width = Number(info?.width)
  const height = Number(info?.height)
  // Vision models bill images by area, roughly (w * h) / 750 tokens, after downscaling to ~1.15MP.
  if (width > 0 && height > 0) return Math.min(Math.ceil((width * height) / 750), 1600)
  return 1000
}

const OVERHEAD = "Overhead"

class Bucket {
  private readonly items = new Map<string, { tokens: number; count: number; detail?: string }>()
  private shared?: { name: string; tokens: number; detail: string }

  add(name: string, tokens: number, detail?: string) {
    if (tokens <= 0) return
    const existing = this.items.get(name)
    if (existing) {
      existing.tokens += tokens
      existing.count++
      return
    }
    this.items.set(name, { tokens, count: 1, detail })
  }

  /** Shared text of the category that no single item accounts for. */
  overhead(tokens: number, detail: string, name = OVERHEAD) {
    if (tokens <= 0) return
    if (this.shared) this.shared.tokens += tokens
    else this.shared = { name, tokens, detail }
  }

  total() {
    let sum = this.shared?.tokens ?? 0
    for (const item of this.items.values()) sum += item.tokens
    return sum
  }

  list(countLabel?: (count: number) => string): Item[] {
    const items: Item[] = [...this.items.entries()].map(([name, item]) => ({
      name,
      tokens: item.tokens,
      detail: item.detail ?? (countLabel ? countLabel(item.count) : undefined),
    }))
    if (this.shared) items.push({ name: this.shared.name, tokens: this.shared.tokens, detail: this.shared.detail, overhead: true })
    return items.sort(byTokens)
  }
}

/** Most to least tokens, with overhead last; ties by name so the order is stable. */
export function byTokens(a: Item, b: Item) {
  return Number(a.overhead ?? false) - Number(b.overhead ?? false) || b.tokens - a.tokens || a.name.localeCompare(b.name)
}

/** Per-server MCP usage: Code Mode catalog entries, tools sent directly, and server instructions. */
class McpUsage {
  private readonly servers = new Map<
    string,
    { tokens: number; catalogTools: number; directTools: number; instructions: boolean }
  >()
  private shared = 0

  constructor(private readonly configured: readonly McpServer[]) {
    for (const server of configured) this.entry(server.name)
  }

  /** Maps a catalog namespace, tool prefix, or instruction name to its configured server name. */
  private resolve(name: string) {
    return this.find(name)?.name ?? name
  }

  private find(name: string) {
    return this.configured.find((server) => server.name === name || sanitize(server.name) === name)
  }

  /** Whether a Code Mode namespace belongs to a configured MCP server, as opposed to built-in or plugin tools. */
  isServer(name: string) {
    return this.find(name) !== undefined
  }

  private entry(name: string) {
    const key = this.resolve(name)
    let entry = this.servers.get(key)
    if (!entry) {
      entry = { tokens: 0, catalogTools: 0, directTools: 0, instructions: false }
      this.servers.set(key, entry)
    }
    return entry
  }

  catalog(name: string, tokens: number, tools: number) {
    const entry = this.entry(name)
    entry.tokens += tokens
    entry.catalogTools += tools
  }

  tool(name: string, tokens: number) {
    const entry = this.entry(name)
    entry.tokens += tokens
    entry.directTools++
  }

  instructions(name: string, tokens: number) {
    const entry = this.entry(name)
    entry.tokens += tokens
    entry.instructions = true
  }

  /** Shared MCP text, such as the `<mcp_instructions>` wrapper, that no single server accounts for. */
  overhead(tokens: number) {
    if (tokens > 0) this.shared += tokens
  }

  list(): Item[] {
    const items = [...this.servers.entries()].map(([name, entry]): Item => {
      const parts: string[] = []
      if (entry.catalogTools > 0) parts.push(codeModeDetail(entry.catalogTools))
      if (entry.directTools > 0) parts.push(plural(entry.directTools, "tool"))
      if (entry.instructions) parts.push("includes server instructions")
      // The row already reads "0 tokens", so a server that adds nothing only needs its reason.
      if (entry.tokens <= 0) {
        const status = this.configured.find((server) => server.name === name)?.status
        parts.push(status && status !== "connected" ? status.replace(/_/g, " ") : "adds no tools or instructions")
      }
      return { name, tokens: entry.tokens, detail: parts.join(" · ") || undefined }
    })
    if (this.shared > 0) {
      items.push({ name: OVERHEAD, tokens: this.shared, detail: "wrapper around server instructions", overhead: true })
    }
    return items
  }
}

/** Names of the thread's grouped rows, shared with the server part so it can add the latest reply. */
export const THREAD = {
  tools: "Tool use",
  output: "Model output",
  replies: "Replies",
  reasoning: "Reasoning",
  user: "Your messages",
  formatting: "Formatting",
} as const

/** A row whose tokens are the sum of its children, sorted most to least. */
export function group(name: string, children: Item[], detail?: string): Item {
  const sorted = [...children].sort(byTokens)
  return { name, tokens: sorted.reduce((sum, item) => sum + item.tokens, 0), detail, children: sorted }
}

/**
 * The conversation, grouped by what makes it grow: tool use (each tool's calls and results together,
 * since both stay in the thread), the model's own output, and everything else as flat rows.
 */
class ThreadUsage {
  private readonly tools = new Map<string, { call: number; result: number; calls: number; results: number }>()
  private readonly output = new Bucket()
  private readonly rest = new Bucket()

  private tool(name: string) {
    let entry = this.tools.get(name)
    if (!entry) {
      entry = { call: 0, result: 0, calls: 0, results: 0 }
      this.tools.set(name, entry)
    }
    return entry
  }

  call(name: string, tokens: number) {
    const entry = this.tool(name)
    entry.call += tokens
    entry.calls++
  }

  result(name: string, tokens: number) {
    const entry = this.tool(name)
    entry.result += tokens
    entry.results++
  }

  /** The model's replies and reasoning. */
  model(name: string, tokens: number) {
    this.output.add(name, tokens, MESSAGE_DETAILS[name])
  }

  add(name: string, tokens: number) {
    this.rest.add(name, tokens, MESSAGE_DETAILS[name])
  }

  formatting(tokens: number) {
    this.rest.overhead(tokens, "markup that separates messages", THREAD.formatting)
  }

  list(): Item[] {
    const items = this.rest.list()
    let calls = 0
    const tools = [...this.tools.entries()].map(([name, entry]): Item => {
      const count = Math.max(entry.calls, entry.results)
      calls += count
      // Edits and writes carry their content in the call, so their results alone understate them.
      const detail = entry.call > entry.result ? `${plural(count, "call")} · mostly what the model sent` : plural(count, "call")
      return { name, tokens: entry.call + entry.result, detail }
    })
    if (tools.length > 0) items.push(group(THREAD.tools, tools, plural(calls, "call")))
    const output = this.output.list()
    if (output.length > 0) items.push(group(THREAD.output, output))
    return items.sort(byTokens)
  }
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/**
 * Code Mode tools aren't sent as full definitions; the model calls them by writing a script for the
 * `execute` tool, and only short signatures are listed in the system prompt.
 */
function codeModeDetail(count: number) {
  return `${plural(count, "tool")} called from scripts (Code Mode)`
}

/** Splits `core/instructions` into one item per instruction file. */
function splitInstructions(text: string, bucket: Bucket) {
  const pattern = /^Instructions from: (.+)$/gm
  const starts: { index: number; path: string }[] = []
  for (const match of text.matchAll(pattern)) starts.push({ index: match.index ?? 0, path: match[1]!.trim() })
  if (starts.length === 0) {
    bucket.add("Instruction files", estimate(text))
    return
  }
  if (starts[0]!.index > 0) bucket.add("Other instructions", estimate(text.slice(0, starts[0]!.index)))
  starts.forEach((start, i) => {
    const end = starts[i + 1]?.index ?? text.length
    bucket.add(start.path, estimate(text.slice(start.index, end)))
  })
}

/** Splits `core/skill-guidance` into one item per advertised skill plus the shared guidance text. */
function splitSkills(text: string, bucket: Bucket) {
  let rest = text
  for (const match of text.matchAll(/<skill>[\s\S]*?<\/skill>/g)) {
    const block = match[0]
    const name = /<id>([\s\S]*?)<\/id>/.exec(block)?.[1] ?? /<name>([\s\S]*?)<\/name>/.exec(block)?.[1] ?? "skill"
    bucket.add(name.trim(), estimate(block))
    rest = rest.replace(block, "")
  }
  bucket.overhead(estimate(rest), "guidance on using skills, and the list around them")
}

/**
 * Splits the Code Mode catalog by namespace (`- name (N tools...)` sections). Namespaces of
 * configured MCP servers go to their server; the rest (OpenCode's own `opencode` namespace, plugin
 * tools) are system tools, and the shared guidance on using `execute` is system tools overhead.
 */
function splitCodeMode(text: string, tools: Bucket, servers: McpUsage) {
  const pattern = /^- ([^\s(]+) \((\d+) tools?[^)]*\)/gm
  const starts: { index: number; name: string; count: number }[] = []
  for (const match of text.matchAll(pattern)) {
    starts.push({ index: match.index ?? 0, name: match[1]!, count: Number(match[2]) })
  }
  if (starts.length === 0) {
    tools.add("Script-callable tools", estimate(text), "tools called from scripts (Code Mode)")
    return
  }
  tools.overhead(estimate(text.slice(0, starts[0]!.index)), "how to call tools from scripts (Code Mode)")
  starts.forEach((start, i) => {
    const end = starts[i + 1]?.index ?? text.length
    const tokens = estimate(text.slice(start.index, end))
    if (servers.isServer(start.name)) servers.catalog(start.name, tokens, start.count)
    else tools.add(start.name, tokens, codeModeDetail(start.count))
  })
}

/**
 * Splits `core/mcp-guidance` into each server's `<server name="...">` block. The shared
 * `<mcp_instructions>` wrapper is not caused by any one server, so it is reported as MCP overhead.
 */
function splitMcpInstructions(text: string, system: Bucket, servers: McpUsage) {
  let rest = text
  let found = false
  for (const match of text.matchAll(/<server name="([^"]+)">[\s\S]*?<\/server>/g)) {
    servers.instructions(match[1]!, estimate(match[0]))
    rest = rest.replace(match[0], "")
    found = true
  }
  // Without any server blocks the format is unrecognized, so keep the text as one system item.
  if (found) servers.overhead(estimate(rest))
  else system.add("MCP instructions", estimate(rest), SYSTEM_DETAILS["MCP instructions"])
}

const SOURCE_LABELS: Record<string, string> = {
  "core/environment": "Environment",
  "core/date": "Date",
}

/** Plain descriptions for system prompt rows whose names are OpenCode terms. */
const SYSTEM_DETAILS: Record<string, string> = {
  "Agent prompt": "the active agent's base instructions",
  Environment: "working directory, platform, and similar",
  "Plugin additions": "text other plugins add to the system prompt",
  "MCP instructions": "instructions from connected servers",
}

const COMPACTION = "Compaction summary"

/** Plain descriptions for message rows whose names are OpenCode terms. */
const MESSAGE_DETAILS: Record<string, string> = {
  "System reminders": "notes OpenCode adds to the conversation",
  [THREAD.reasoning]: "the model's thinking before it answers",
  [COMPACTION]: "summary that replaced earlier messages",
}

/**
 * OpenCode sends its own compaction summary as a user message wrapped in `<conversation-checkpoint>`,
 * along with a record of the recent messages it kept; only provider-native compaction arrives as
 * `compaction` parts.
 */
function isCheckpoint(message: MessageLike, text: string) {
  return (
    message.role === "user" &&
    text.startsWith("<conversation-checkpoint>\n") &&
    text.trimEnd().endsWith("</conversation-checkpoint>")
  )
}

function sanitize(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_")
}

/** OpenCode terms that keep their capitals when a heading is sentence-cased. */
const TERMS = ["Code Mode"]

/** "Your Model" → "Your model", to match the other rows; all-caps and camel-case words are left alone. */
function sentenceCase(text: string) {
  let result = text.replace(/(?<=\s)[A-Z][a-z]+\b/g, (word) => word.toLowerCase())
  for (const term of TERMS) result = result.replace(new RegExp(term, "gi"), term)
  return result
}

/** Longest label kept for prose, so the token count stays on the same line. */
const MAX_LABEL = 28

/** Cuts at a word boundary, so a long sentence reads as a short preview. */
function preview(text: string, max = MAX_LABEL) {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(" ")
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`
}

function describeSystemPart(text: string, options: AnalyzeOptions): string {
  if (options.agentPrompt && text.trim() === options.agentPrompt.trim()) return "Agent prompt"
  const firstLine = text.trim().split("\n")[0]?.trim() ?? ""
  const heading = /^#+\s*(.+)$/.exec(firstLine)?.[1]?.trim()
  if (heading) return preview(sentenceCase(heading))
  if (!firstLine) return "System text"
  return preview(firstLine)
}

export function analyze(capture: Capture, options: AnalyzeOptions): Analysis {
  const buckets: Record<CategoryID, Bucket> = {
    system: new Bucket(),
    tools: new Bucket(),
    mcp: new Bucket(),
    instructions: new Bucket(),
    skills: new Bucket(),
    messages: new Bucket(),
    other: new Bucket(),
  }
  const thread = new ThreadUsage()
  const mcpServers = new McpUsage(options.mcpServers)

  // System prompt parts.
  for (const part of capture.system) {
    const sources = (part.metadata?.experimental as { instructions?: unknown } | undefined)?.instructions
    if (!Array.isArray(sources)) {
      const name = describeSystemPart(part.text, options)
      buckets.system.add(name, estimate(part.text), SYSTEM_DETAILS[name])
      continue
    }
    let attributed = 0
    for (const source of sources as { key?: string; text?: string }[]) {
      const key = String(source.key ?? "unknown")
      const text = String(source.text ?? "")
      const tokens = estimate(text)
      attributed += tokens
      if (key === "core/instructions") splitInstructions(text, buckets.instructions)
      else if (key === "core/skill-guidance") splitSkills(text, buckets.skills)
      else if (key === "core/codemode") splitCodeMode(text, buckets.tools, mcpServers)
      else if (key === "core/mcp-guidance") splitMcpInstructions(text, buckets.system, mcpServers)
      else {
        const name = SOURCE_LABELS[key] ?? key.replace(/^core\//, "")
        buckets.system.add(name, tokens, SYSTEM_DETAILS[name])
      }
    }
    // Text added to the part by other plugins after OpenCode assembled it.
    const extra = estimate(part.text) - attributed
    if (extra > 16) buckets.system.add("Plugin additions", extra, SYSTEM_DETAILS["Plugin additions"])
  }

  // Tool definitions sent with the request.
  const servers = options.mcpServers.map((server) => server.name).sort((a, b) => b.length - a.length)
  for (const [name, tool] of Object.entries(capture.tools)) {
    const tokens = estimate(name) + estimate(tool.description ?? "") + estimate(stringify(tool.input)) + 8
    const server = servers.find((server) => name.startsWith(`${sanitize(server)}_`) || name.startsWith(`${server}_`))
    if (server) mcpServers.tool(server, tokens)
    else buckets.tools.add(name, tokens)
  }

  // Conversation messages.
  for (const message of capture.messages) {
    let messageTokens = 0
    const count = (tokens: number) => {
      messageTokens += tokens
      return tokens
    }
    for (const part of message.content) {
      switch (part.type) {
        case "text":
          if (message.role === "system") thread.add("System reminders", count(estimate(part.text)))
          else if (message.role === "assistant") thread.model(THREAD.replies, count(estimate(part.text)))
          else if (isCheckpoint(message, part.text)) thread.add(COMPACTION, count(estimate(part.text)))
          else thread.add(THREAD.user, count(estimate(part.text)))
          break
        case "media":
          thread.add("Attachments", count(estimateMedia(part)))
          break
        case "reasoning":
          thread.model(THREAD.reasoning, count(estimate(part.text ?? "")))
          break
        case "tool-call":
          thread.call(
            String(part.name ?? "tool"),
            count(estimate(String(part.name ?? "")) + estimate(stringify(part.input)) + 8),
          )
          break
        case "tool-result":
          thread.result(String(part.name ?? "tool"), count(estimate(stringify(part.result)) + 8))
          break
        case "compaction":
          thread.add(COMPACTION, count(estimate(part.text ?? "") || 500))
          break
        case "effort":
          break
        default:
          thread.add("Other content", count(estimate(stringify(part))))
      }
    }
    if (messageTokens > 0) thread.formatting(4)
  }

  // One row per MCP server. Shared Code Mode text and non-MCP namespaces are counted as system tools.
  const mcpItems = mcpServers.list().sort(byTokens)
  const categories = CATEGORY_ORDER.map((id) => {
    const items = id === "mcp" ? mcpItems : id === "messages" ? thread.list() : buckets[id].list()
    return { id, label: LABELS[id], tokens: items.reduce((sum, item) => sum + item.tokens, 0), items }
  })
    // MCP stays listed while servers are configured, even when none of them adds to the context.
    .filter((category) => category.tokens > 0 || (category.id === "mcp" && category.items.length > 0))

  return {
    categories,
    total: categories.reduce((sum, category) => sum + category.tokens, 0),
  }
}

/** Scales every estimate by `factor`, keeping categories consistent with their items. */
export function scale(analysis: Analysis, factor: number): Analysis {
  const categories = analysis.categories.map((category) => scaleCategory(category, factor))
  return { categories, total: categories.reduce((sum, category) => sum + category.tokens, 0) }
}

/** Rounds each leaf, so a group still adds up to exactly the sum of its children. */
function scaleItems(items: readonly Item[], factor: number): Item[] {
  return items.map((item) => {
    if (!item.children) return { ...item, tokens: Math.round(item.tokens * factor) }
    const children = scaleItems(item.children, factor)
    return { ...item, children, tokens: children.reduce((sum, child) => sum + child.tokens, 0) }
  })
}

function scaleCategory(category: Category, factor: number): Category {
  const items = scaleItems(category.items, factor)
  return { ...category, tokens: items.reduce((sum, item) => sum + item.tokens, 0), items }
}

const FIXED = BASELINE

/** Lowest factor applied to the conversation, so it can't vanish when the fixed factor overshoots. */
const MIN_THREAD_FACTOR = 0.5

/**
 * Matches the estimates to the provider-reported `prompt` while keeping fixed costs (system prompt,
 * tools, instructions, skills) at their initial size: those are scaled by `fixed`, the factor measured
 * on the thread's first request. What remains of the prompt belongs to the conversation, so messages
 * absorb whatever the estimates miss as the thread grows (encrypted reasoning, dense tool output).
 */
export function calibrateThread(analysis: Analysis, fixed: number, prompt: number): Analysis {
  const fixedCategories = analysis.categories.filter((category) => FIXED.has(category.id))
  const fixedRaw = fixedCategories.reduce((sum, category) => sum + category.tokens, 0)
  const threadRaw = analysis.total - fixedRaw
  const fixedTokens = fixedRaw * fixed
  const thread = threadRaw > 0 ? Math.max((prompt - fixedTokens) / threadRaw, MIN_THREAD_FACTOR) : fixed
  const categories = analysis.categories.map((category) =>
    scaleCategory(category, FIXED.has(category.id) ? fixed : thread),
  )
  return { categories, total: categories.reduce((sum, category) => sum + category.tokens, 0) }
}

export { LABELS }
