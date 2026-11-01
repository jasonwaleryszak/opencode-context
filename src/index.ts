import { Plugin } from "@opencode/plugin"
import {
  analyze,
  byTokens,
  calibrateThread,
  group,
  scale,
  THREAD,
  type Analysis,
  type Capture,
  type McpServer,
} from "./analyze.js"
import { formatTokens } from "./format.js"
import {
  ContextRpc,
  type Breakdown,
  type BreakdownInput,
  type Category,
  type Item,
  type ModelSummary,
  type ReportedUsage,
} from "./rpc.js"

/** How many sessions keep their latest request in memory. */
const MAX_SESSIONS = 32
/** How many request totals per session are kept to match provider-reported usage. */
const MAX_HISTORY = 16
/** How many persisted session summaries are kept. */
const MAX_STORED = 200
const PERSIST_DELAY = 2_000
const CACHE_TTL = 30_000
const STORAGE_PREFIX = "capture/"

interface HistoryEntry {
  readonly at: number
  readonly raw: number
}

interface Stored {
  readonly at: number
  readonly agent: string
  readonly model: Capture["model"]
  readonly analysis: Analysis
  readonly history: readonly HistoryEntry[]
  /** Calibration of the thread's first request, applied to fixed costs. */
  readonly base?: number
}

// Module scope so every plugin instance in this process shares the captures.
const captures = new Map<string, Capture>()
const histories = new Map<string, HistoryEntry[]>()
/** Per session, the calibration factor of the first request in the thread. */
const bases = new Map<string, number>()
/** Per model, the latest first-request factor, for threads whose first request wasn't observed. */
const modelBases = new Map<string, number>()
/**
 * Per session, the thread start (see `threadStart`) whose base couldn't be measured, so the full
 * context isn't fetched again on every request only to fail again.
 */
const unmeasured = new Map<string, string>()
/** Per session, a pending load of the stored history and base; see `hydrate`. */
const hydrations = new Map<string, Promise<void>>()

function modelKey(model: { readonly providerID: string; readonly id: string }) {
  return `${model.providerID}/${model.id}`
}

function remember(capture: Capture) {
  captures.delete(capture.sessionID)
  captures.set(capture.sessionID, capture)
  while (captures.size > MAX_SESSIONS) {
    const oldest = captures.keys().next().value
    if (oldest === undefined) break
    captures.delete(oldest)
    histories.delete(oldest)
    bases.delete(oldest)
    unmeasured.delete(oldest)
  }
}

/** The first entry stays, since the thread's first request calibrates its fixed costs. */
function trim(history: HistoryEntry[]) {
  if (history.length > MAX_HISTORY) history.splice(1, history.length - MAX_HISTORY)
  return history
}

function record(sessionID: string, entry: HistoryEntry) {
  const history = histories.get(sessionID) ?? []
  history.push(entry)
  histories.set(sessionID, trim(history))
}

/** Stored entries go before newer ones in memory; the same capture can be in both. */
function mergeHistory(stored: readonly HistoryEntry[], current: readonly HistoryEntry[]) {
  const seen = new Set(current.map((entry) => entry.at))
  return trim([...stored.filter((entry) => !seen.has(entry.at)), ...current].sort((a, b) => a.at - b.at))
}

/**
 * Compaction replaces earlier messages, so the thread's first response changes and a base that
 * couldn't be measured before may become measurable. OpenCode's summary replaces the first message
 * (system reminders aside), which ordinary turns leave alone; provider-native compaction adds
 * `compaction` parts.
 */
function threadStart(capture: Capture) {
  let count = 0
  let length = 0
  for (const message of capture.messages) {
    for (const part of message.content) {
      if (part.type !== "compaction") continue
      count++
      length += String(part.text ?? "").length
    }
  }
  const first = capture.messages.find((message) => message.role !== "system")
  // Without an ID, the shape of the message stands in for it.
  const head =
    first?.id ??
    (first ? `${first.role}:${first.content.map((part) => `${part.type}${String(part.text ?? "").length}`).join(",")}` : "")
  return `${head}|${count}:${length}`
}

function unwrap<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  const data = (value as { data?: unknown } | undefined)?.data
  return Array.isArray(data) ? (data as T[]) : []
}

function cached<T>(load: () => Promise<T>, fallback: T) {
  let value: { at: number; data: T } | undefined
  return async () => {
    if (value && Date.now() - value.at < CACHE_TTL) return value.data
    const data = await load().catch(() => fallback)
    value = { at: Date.now(), data }
    return data
  }
}

/**
 * A request is captured as its assistant message is created, before the response streams. The next
 * request is captured after the response completes. These bounds attribute responses to captures,
 * since `created` and the capture can share a millisecond.
 */
function responseStart(message: any): number {
  return Number(message.time?.streamed ?? message.time?.completed ?? message.time?.created ?? 0)
}

function responseEnd(message: any): number {
  return Number(message.time?.completed ?? Number.POSITIVE_INFINITY)
}

type Usage = ReportedUsage & { model?: ModelSummary; start: number }

function usageOf(message: any): Usage | undefined {
  if (message?.type !== "assistant" || !message.tokens) return undefined
  const tokens = message.tokens
  const cacheRead = Number(tokens.cache?.read ?? 0)
  const cacheWrite = Number(tokens.cache?.write ?? 0)
  const input = Number(tokens.input ?? 0)
  const prompt = input + cacheRead + cacheWrite
  if (prompt <= 0) return undefined
  return {
    prompt,
    input,
    output: Number(tokens.output ?? 0),
    reasoning: Number(tokens.reasoning ?? 0),
    cacheRead,
    cacheWrite,
    at: Number(message.time?.created ?? 0),
    start: responseStart(message),
    model: message.model,
  }
}

function lastUsage(messages: readonly any[]): Usage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = usageOf(messages[i])
    if (usage) return usage
  }
  return undefined
}

/** Usage of the first response in the context: since the last compaction, or of the whole session. */
function firstUsage(messages: readonly any[]): Usage | undefined {
  for (const message of messages) {
    if (message?.type !== "assistant") continue
    return usageOf(message)
  }
  return undefined
}

/** Output of responses that finished after the capture; they are not part of the captured request yet. */
function outputSince(messages: readonly any[], since: number) {
  let total = 0
  for (const message of messages) {
    if (message?.type !== "assistant" || !message.tokens) continue
    if (responseEnd(message) < since) continue
    total += Number(message.tokens.output ?? 0)
  }
  return total
}

/** Counts the latest reply, which the captured request doesn't hold yet, in the thread's replies. */
function addPending(categories: readonly Category[], pending: number): Category[] {
  if (pending <= 0) return [...categories]
  const reply: Item = { name: THREAD.replies, tokens: pending }
  const withReply = (items: readonly Item[]): Item[] => {
    const output = items.find((item) => item.name === THREAD.output && item.children)
    if (!output) return [...items, group(THREAD.output, [reply])].sort(byTokens)
    const children = output.children!.some((child) => child.name === THREAD.replies)
      ? output.children!.map((child) => (child.name === THREAD.replies ? { ...child, tokens: child.tokens + pending } : child))
      : [...output.children!, reply]
    return items.map((item) => (item === output ? group(THREAD.output, children, output.detail) : item)).sort(byTokens)
  }
  const thread = categories.find((category) => category.id === "messages")
  if (!thread) return [...categories, { id: "messages", label: "This thread", tokens: pending, items: withReply([]) }]
  return categories.map((category) =>
    category === thread ? { ...category, tokens: category.tokens + pending, items: withReply(category.items) } : category,
  )
}

/**
 * The estimate for the request that produced the reported usage is the latest one captured before
 * that response started streaming. Its ratio converts character estimates into provider tokens.
 */
function calibrate(history: readonly HistoryEntry[], start: number | undefined, prompt: number) {
  if (start === undefined || history.length === 0) return undefined
  const match = history.filter((entry) => entry.at <= start).at(-1)
  if (!match || match.raw <= 0) return undefined
  return Math.min(Math.max(prompt / match.raw, 0.5), 2.5)
}

/**
 * Fixed costs (system prompt, tools, instructions, skills) are calibrated on the thread's first
 * request, when the conversation is smallest, so the conversation's growth doesn't inflate them.
 */
function measureBase(
  sessionID: string,
  model: Capture["model"] | undefined,
  history: readonly HistoryEntry[],
  messages: readonly any[],
) {
  const known = bases.get(sessionID)
  if (known !== undefined) return known
  const first = firstUsage(messages)
  const factor = first && calibrate(history, first.start, first.prompt)
  if (!factor) return undefined
  bases.set(sessionID, factor)
  if (bases.size > MAX_STORED) bases.delete(bases.keys().next().value!)
  if (model) {
    modelBases.delete(modelKey(model))
    modelBases.set(modelKey(model), factor)
  }
  return factor
}

export default Plugin.define({
  id: "opencode-context",
  async setup(ctx) {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const mcpServers = cached(
      async () =>
        unwrap<{ name: string; status?: { status?: string } }>(await ctx.mcp.list()).map(
          (server): McpServer => ({ name: server.name, status: server.status?.status }),
        ),
      [] as McpServer[],
    )
    const agentPrompts = new Map<string, () => Promise<string | undefined>>()
    const agentPrompt = (agentID: string) => {
      let load = agentPrompts.get(agentID)
      if (!load) {
        load = cached(async () => {
          const response = (await ctx.agent.get({ agentID })) as unknown as { data?: { system?: string } }
          return response?.data?.system
        }, undefined)
        agentPrompts.set(agentID, load)
      }
      return load()
    }
    const models = cached(async () => unwrap<any>(await ctx.model.list()), [] as any[])

    const analyzeCapture = async (capture: Capture) =>
      analyze(capture, { mcpServers: await mcpServers(), agentPrompt: await agentPrompt(capture.agent) })

    /**
     * A session's first capture after eviction or a restart starts a fresh history, which can't
     * measure the base. Loading the stored history and base keeps them from being overwritten.
     */
    const hydrate = (sessionID: string) => {
      if (histories.has(sessionID) || hydrations.has(sessionID)) return
      const done = (async () => {
        const stored = (await ctx.storage.get(`${STORAGE_PREFIX}${sessionID}`)) as Stored | undefined
        // Evicted again while loading; the next capture hydrates afresh.
        if (!stored || !captures.has(sessionID)) return
        if (Array.isArray(stored.history)) {
          histories.set(sessionID, mergeHistory(stored.history, histories.get(sessionID) ?? []))
        }
        if (typeof stored.base === "number" && !bases.has(sessionID)) bases.set(sessionID, stored.base)
      })()
        .catch(() => {})
        .finally(() => hydrations.delete(sessionID))
      hydrations.set(sessionID, done)
    }

    const persist = async (sessionID: string) => {
      await hydrations.get(sessionID)
      const capture = captures.get(sessionID)
      if (!capture) return
      const history = histories.get(sessionID) ?? []
      let base = bases.get(sessionID)
      const start = threadStart(capture)
      if (base === undefined && unmeasured.get(sessionID) !== start) {
        const messages = (await ctx.session.context({ sessionID }).catch(() => [])) as readonly any[]
        base = measureBase(sessionID, capture.model, history, messages)
        // With a first response that no capture precedes, retrying can't succeed until compaction.
        if (base === undefined && firstUsage(messages) && captures.has(sessionID)) unmeasured.set(sessionID, start)
      }
      const stored: Stored = {
        at: capture.at,
        agent: capture.agent,
        model: capture.model,
        analysis: await analyzeCapture(capture),
        history,
        base,
      }
      await ctx.storage.set(`${STORAGE_PREFIX}${sessionID}`, stored as any)
    }

    const schedulePersist = (sessionID: string) => {
      clearTimeout(timers.get(sessionID))
      timers.set(
        sessionID,
        setTimeout(() => {
          timers.delete(sessionID)
          persist(sessionID).catch(() => {})
        }, PERSIST_DELAY),
      )
    }

    // Keep stored summaries bounded.
    void (async () => {
      const entries: { key: string; at: number }[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: STORAGE_PREFIX, after, limit: 500 })
        for (const entry of page.entries) entries.push({ key: entry.key, at: Number((entry.value as any)?.at ?? 0) })
        after = page.next
      } while (after)
      entries.sort((a, b) => b.at - a.at)
      await Promise.all(entries.slice(MAX_STORED).map((entry) => ctx.storage.remove(entry.key)))
    })().catch(() => {})

    await ctx.session.hook("context", (event) => {
      const capture: Capture = {
        sessionID: event.sessionID,
        at: Date.now(),
        agent: event.agent,
        model: { providerID: event.model.providerID, id: event.model.id, variant: event.model.variant },
        system: event.system,
        messages: event.messages as unknown as Capture["messages"],
        tools: event.tools,
      }
      remember(capture)
      hydrate(capture.sessionID)
      // Estimate off the request path; the total only depends on content, not attribution.
      setTimeout(() => {
        record(capture.sessionID, { at: capture.at, raw: analyze(capture, { mcpServers: [] }).total })
        schedulePersist(capture.sessionID)
      }, 0)
    })

    const describeModel = async (ref: { providerID: string; id: string; variant?: string } | undefined) => {
      if (!ref) return undefined
      const info = (await models()).find((model) => model.providerID === ref.providerID && model.id === ref.id)
      const summary: ModelSummary = {
        providerID: ref.providerID,
        id: ref.id,
        variant: ref.variant,
        name: info?.name,
        limit: info?.limit
          ? { context: info.limit.context, input: info.limit.input, output: info.limit.output }
          : undefined,
      }
      return summary
    }

    /** Most recent capture from any session, preferring one made by `agent`. */
    const latestCapture = (agent: string | undefined) => {
      const all = [...captures.values()].reverse()
      return all.find((capture) => agent && capture.agent === agent) ?? all[0]
    }

    /**
     * Fixed overhead (system prompt, tools, instructions, skills) barely differs between sessions, so a
     * session that has not sent anything borrows it from the most recent request in another session.
     */
    const baseline = async (
      sessionID: string | undefined,
      agent: string | undefined,
      model: ModelSummary | undefined,
    ): Promise<Breakdown> => {
      const source = latestCapture(agent)
      if (!source) {
        return {
          sessionID: sessionID ?? "",
          status: "empty",
          model,
          categories: [],
          total: 0,
          notes: ["Nothing has been sent in this session yet; send a message to see a breakdown."],
        }
      }
      const other = await breakdown(source.sessionID)
      const categories = other.categories.filter((category) => category.id !== "messages")
      return {
        ...other,
        sessionID: sessionID ?? "",
        model: model ?? other.model,
        categories,
        total: categories.reduce((sum, category) => sum + category.tokens, 0),
        reported: undefined,
        notes: ["Nothing has been sent in this session yet, so these fixed costs come from your latest request in another session."],
      }
    }

    const breakdown = async (sessionID: string): Promise<Breakdown> => {
      const [messages, session] = await Promise.all([
        ctx.session.context({ sessionID }).catch(() => [] as readonly unknown[]),
        ctx.session.get({ sessionID }).catch(() => undefined),
      ])
      const usage = lastUsage(messages as readonly any[])
      const reported: ReportedUsage | undefined = usage && {
        prompt: usage.prompt,
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        at: usage.at,
      }

      await hydrations.get(sessionID)
      const capture = captures.get(sessionID)
      const stored = capture ? undefined : ((await ctx.storage.get(`${STORAGE_PREFIX}${sessionID}`)) as Stored | undefined)
      const notes: string[] = []

      if (!capture && !stored) {
        const model = await describeModel(usage?.model ?? (session as any)?.model)
        if (!reported) return baseline(sessionID, (session as any)?.agent, model)
        const total = reported.prompt + reported.output
        return {
          sessionID,
          status: "usage-only",
          model,
          categories: [{ id: "other", label: "Not yet analyzed", tokens: total, items: [] }],
          total,
          reported,
          notes: [
            "No request from this session has been seen since the plugin loaded; send a message for a detailed breakdown.",
          ],
        }
      }

      const capturedAt = capture?.at ?? stored!.at
      const raw = capture ? await analyzeCapture(capture) : stored!.analysis
      const history = [...(histories.get(sessionID) ?? stored?.history ?? [])]
      // A capture that has not been measured yet is its own most recent entry.
      if (capture && !history.some((entry) => entry.at === capture.at)) history.push({ at: capture.at, raw: raw.total })
      const factor = calibrate(history, usage?.start, usage?.prompt ?? 0)
      const model = capture?.model ?? stored?.model
      // A stored base isn't copied into `bases`: `remember` only evicts captured sessions from it, and
      // `hydrate` loads it once the session is captured again.
      const base =
        stored?.base ??
        measureBase(sessionID, model, history, messages as readonly any[]) ??
        (model && modelBases.get(modelKey(model)))
      // Fixed costs keep their first-request size; the rest of the reported prompt is the conversation's.
      const scaled = factor ? calibrateThread(raw, base ?? 1, factor * raw.total) : base ? scale(raw, base) : raw

      const pending = outputSince(messages as readonly any[], capturedAt)
      const categories = addPending(scaled.categories, pending)

      if (!factor) notes.push("Estimated from text length; provider-reported usage was not available to calibrate.")
      else if (!base) notes.push("Fixed costs are estimated from text length; this thread's first request wasn't observed.")
      if (!capture) notes.push("Showing the last saved breakdown; it refreshes with the next message.")
      if (pending > 0) {
        notes.push(
          `This thread includes ${formatTokens(pending)} tokens from the latest reply, which the model receives with your next message.`,
        )
      }

      return {
        sessionID,
        status: "captured",
        capturedAt,
        agent: capture?.agent ?? stored?.agent,
        model: await describeModel(model),
        categories,
        total: categories.reduce((sum, category) => sum + category.tokens, 0),
        reported,
        calibration: factor,
        notes,
      }
    }

    await ctx.rpc.register(ContextRpc, {
      breakdown: async (input) => {
        const { sessionID, agent } = (input ?? {}) as BreakdownInput
        const result = sessionID ? await breakdown(sessionID) : await baseline(undefined, agent, undefined)
        // Round-trip through JSON: RPC output must be plain JSON, without `undefined` fields.
        return JSON.parse(JSON.stringify(result))
      },
    })

    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  },
})
