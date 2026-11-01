/** @jsxImportSource @opentui/solid */
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import {
  bufferTokens,
  formatPercent,
  formatTokens,
  layoutGrid,
  type Cell,
  type CompactionSettings,
} from "./format.js"
import {
  BASELINE,
  ContextRpc,
  type Breakdown,
  type Category,
  type CategoryID,
  type Item,
  type ModelSummary,
} from "./rpc.js"

const GRID_COLUMNS = 10
const SYMBOL = { used: "■", partial: "▪", free: "□", buffer: "⊠" }

type Theme = Context["theme"]

interface Palette {
  readonly categories: Record<CategoryID, RGBA>
  readonly text: RGBA
  readonly muted: RGBA
  readonly faint: RGBA
  readonly warning: RGBA
  readonly error: RGBA
}

/**
 * Fixed category colors from IBM's Carbon palette (which carbonfox is built on), so each category
 * keeps its color in every session and theme. Light themes use darker shades of the same hues.
 */
const CATEGORY_COLORS: Record<"dark" | "light", Record<Exclude<CategoryID, "other">, string>> = {
  dark: {
    system: "#78a9ff",
    tools: "#be95ff",
    mcp: "#3ddbd9",
    instructions: "#f1c21b",
    skills: "#ff7eb6",
    messages: "#42be65",
  },
  light: {
    system: "#0f62fe",
    tools: "#8a3ffc",
    mcp: "#007d79",
    instructions: "#b28600",
    skills: "#d02670",
    messages: "#198038",
  },
}

function palette(theme: Theme, mode: "dark" | "light"): Palette {
  const feedback = theme.text.feedback
  const hex = CATEGORY_COLORS[mode]
  return {
    categories: {
      system: RGBA.fromHex(hex.system),
      tools: RGBA.fromHex(hex.tools),
      mcp: RGBA.fromHex(hex.mcp),
      instructions: RGBA.fromHex(hex.instructions),
      skills: RGBA.fromHex(hex.skills),
      messages: RGBA.fromHex(hex.messages),
      other: theme.text.muted,
    },
    text: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    warning: feedback.warning.base,
    error: feedback.error.base,
  }
}

async function readCompaction(context: Context, location: { directory: string }): Promise<CompactionSettings> {
  const settings: { auto: boolean; buffer?: string | number } = { auto: true }
  try {
    const entries = (await context.client.config.get({ location })) as unknown
    const list = Array.isArray(entries) ? entries : ((entries as { data?: unknown[] })?.data ?? [])
    for (const entry of list as { info?: { compaction?: { auto?: boolean; buffer?: string | number } } }[]) {
      const compaction = entry.info?.compaction
      if (!compaction) continue
      if (typeof compaction.auto === "boolean") settings.auto = compaction.auto
      if (compaction.buffer !== undefined) settings.buffer = compaction.buffer
    }
  } catch {
    // Fall back to OpenCode's defaults.
  }
  return settings
}

/** The prompt's selected model, for sessions that have not made a request yet. */
function selectedModel(context: Context, location: { directory: string }): ModelSummary | undefined {
  const current = context.ui.model.current()
  if (!current) return undefined
  const info = (context.data.location.model.list(location) ?? []).find(
    (model) => model.providerID === current.providerID && model.id === current.modelID,
  )
  return {
    providerID: current.providerID,
    id: current.modelID,
    variant: current.variant,
    name: info?.name,
    limit: info?.limit,
  }
}

async function show(context: Context) {
  const route = context.ui.router.current()
  // A new session has no ID until its first message; it then shows only the fixed overhead.
  const sessionID = route.type === "session" ? route.sessionID : undefined
  const location = context.location ?? context.data.location.default()
  try {
    // No `agent` for a new session: the plugin API exposes the prompt's selected model, but not its agent.
    const [result, compaction] = await Promise.all([
      context.client.rpc(ContextRpc).breakdown(sessionID ? { sessionID } : {}, { location }) as Promise<Breakdown>,
      readCompaction(context, location),
    ])
    // Without a request of its own, the session will use the prompt's selected model.
    const data =
      sessionID && result.model ? result : { ...result, model: selectedModel(context, location) ?? result.model }
    const running = sessionID !== undefined && context.data.session.status(sessionID) === "running"
    context.ui.dialog.show(() => (
      <ContextView context={context} data={data} compaction={compaction} running={running} />
    ))
    context.ui.dialog.set({ size: "large" })
  } catch (error) {
    context.ui.toast.show({
      title: "Context usage unavailable",
      message: error instanceof Error ? error.message : String(error),
      variant: "error",
    })
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < values.length; i += size) rows.push(values.slice(i, i + size))
  return rows
}

function cellStyle(cell: Cell, colors: Palette) {
  if (cell.kind === "used")
    return { symbol: cell.partial ? SYMBOL.partial : SYMBOL.used, color: colors.categories[cell.category] }
  if (cell.kind === "buffer") return { symbol: SYMBOL.buffer, color: colors.faint }
  return { symbol: SYMBOL.free, color: colors.faint }
}

const THREAD_LABEL = "This thread"

/** Most to least tokens with overhead last, at every level, whatever order a stored breakdown was saved in. */
function sortItems(items: readonly Item[]): Item[] {
  return [...items]
    .map((item) => (item.children ? { ...item, children: sortItems(item.children) } : item))
    .sort(
      (a, b) =>
        Number(a.overhead ?? false) - Number(b.overhead ?? false) || b.tokens - a.tokens || a.name.localeCompare(b.name),
    )
}

/** Flattens a tree into rows, each with the guide lines drawn to its left. */
function treeRows(items: readonly Item[], indent = ""): { prefix: string; item: Item }[] {
  return items.flatMap((item, index) => {
    const last = index === items.length - 1
    const row = { prefix: `${indent}${last ? "└ " : "├ "}`, item }
    return item.children ? [row, ...treeRows(item.children, `${indent}${last ? "  " : "│ "}`)] : [row]
  })
}

/**
 * Baseline categories as branches of one tree, in their usual order. Each has a plain description, so
 * its name can stay OpenCode's term for it.
 */
function baselineTree(categories: readonly Category[]): Item[] {
  const hints: Partial<Record<CategoryID, string>> = {
    system: "agent instructions and environment info",
    tools: "built-in and plugin tools the model can use",
    mcp: "tools from connected servers · /mcps",
    instructions: "your rule files, such as AGENTS.md",
    skills: "guides loaded on demand; summaries only",
  }
  return categories.map((category) => ({
    name: category.label,
    tokens: category.tokens,
    detail: hints[category.id],
    children: category.items.length > 0 ? sortItems(category.items) : undefined,
  }))
}

function sum(categories: readonly Category[]) {
  return categories.reduce((total, category) => total + category.tokens, 0)
}

interface Term {
  readonly term: string
  readonly meaning: string
}

function Glossary(props: { colors: Palette; terms: readonly Term[] }) {
  const { colors } = props
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.terms.map((entry) => (
        // The bullet sits in its own column so wrapped lines stay indented under the text.
        <box flexDirection="row">
          <text fg={colors.faint} flexShrink={0}>
            {"• "}
          </text>
          <text flexShrink={1}>
            <span style={{ fg: colors.muted }}>{entry.term}: </span>
            <span style={{ fg: colors.faint }}>{entry.meaning}</span>
          </text>
        </box>
      ))}
    </box>
  )
}

function Heading(props: { colors: Palette; title: string; hint?: string }) {
  return (
    <text>
      <b>
        <span style={{ fg: props.colors.text }}>{props.title}</span>
      </b>
      {props.hint && <span style={{ fg: props.colors.muted }}> · {props.hint}</span>}
    </text>
  )
}

function Tree(props: { colors: Palette; items: readonly Item[] }) {
  const { colors } = props
  return (
    <box flexDirection="column" flexShrink={0}>
      {treeRows(props.items).map(({ prefix, item }) => (
        <text>
          <span style={{ fg: colors.faint }}>{prefix}</span>
          <span style={{ fg: item.overhead ? colors.muted : colors.text }}>{item.name}: </span>
          <span style={{ fg: colors.muted }}>
            {formatTokens(item.tokens)} tokens{item.detail ? ` · ${item.detail}` : ""}
          </span>
        </text>
      ))}
    </box>
  )
}

function ContextView(props: { context: Context; data: Breakdown; compaction: CompactionSettings; running: boolean }) {
  const { context, data, compaction, running } = props
  const colors = palette(context.theme, context.themeMode)
  const limit = data.model?.limit?.context ?? 0
  const buffer = bufferTokens(limit, compaction)
  const free = Math.max(0, limit - data.total - buffer)
  const rows = chunk(layoutGrid(data.categories, limit, buffer), GRID_COLUMNS)
  const usedColor =
    limit > 0 && data.total >= limit - buffer ? colors.error : limit > 0 && data.total >= (limit - buffer) * 0.8 ? colors.warning : colors.text

  const modelTitle = data.model?.name ?? data.model?.id ?? "Unknown model"
  const modelRef = data.model
    ? `${data.model.providerID}/${data.model.id}${data.model.variant ? ` · ${data.model.variant}` : ""}`
    : undefined
  const share = (tokens: number) => (limit > 0 ? ` (${formatPercent(tokens, limit)})` : "")

  const baseline = data.categories.filter((category) => BASELINE.has(category.id))
  const baselineTokens = sum(baseline)
  const rest = data.categories.filter((category) => !BASELINE.has(category.id))
  const thread = data.categories.find((category) => category.id === "messages")
  const label = (category: Category) => (category.id === "messages" ? THREAD_LABEL : category.label)

  // Explain terms that appear in the dialog, only when they do.
  const glossary: Term[] = []
  if (baseline.some((category) => category.items.some((item) => item.overhead))) {
    glossary.push({
      term: "Overhead",
      meaning: "text a category adds once as a whole; removing one tool, server, or skill won't reduce it.",
    })
  }
  if (buffer > 0) {
    glossary.push({
      term: "Autocompact buffer",
      meaning: "space kept free so OpenCode can summarize older messages before the window fills up.",
    })
  }

  const legend = (
    <box flexDirection="column">
      <text fg={colors.text}>
        <b>{modelTitle}</b>
      </text>
      {modelRef && <text fg={colors.muted}>{modelRef}</text>}
      <text fg={usedColor}>
        {limit > 0
          ? `${formatTokens(data.total)}/${formatTokens(limit)} tokens (${formatPercent(data.total, limit)})`
          : `${formatTokens(data.total)} tokens · context limit unknown`}
      </text>
      <text> </text>
      <text fg={colors.muted}>{data.calibration ? "Estimated usage by category" : "Approximate usage by category"}</text>
      {baseline.length > 0 && (
        <text>
          <span style={{ fg: colors.text }}>Baseline: </span>
          <span style={{ fg: colors.muted }}>
            {formatTokens(baselineTokens)} tokens{share(baselineTokens)}
          </span>
        </text>
      )}
      {baseline.map((category: Category) => (
        <text>
          <span style={{ fg: colors.categories[category.id] }}>{`  ${SYMBOL.used} `}</span>
          <span style={{ fg: colors.text }}>{category.label}: </span>
          <span style={{ fg: colors.muted }}>
            {formatTokens(category.tokens)} tokens{share(category.tokens)}
          </span>
        </text>
      ))}
      {rest.map((category: Category) => (
        <text>
          <span style={{ fg: colors.categories[category.id] }}>{SYMBOL.used} </span>
          <span style={{ fg: colors.text }}>{label(category)}: </span>
          <span style={{ fg: colors.muted }}>
            {formatTokens(category.tokens)} tokens{share(category.tokens)}
          </span>
        </text>
      ))}
      {limit > 0 && (
        <text>
          <span style={{ fg: colors.faint }}>{SYMBOL.free} </span>
          <span style={{ fg: colors.text }}>Free space: </span>
          <span style={{ fg: colors.muted }}>
            {formatTokens(free)} tokens{share(free)}
          </span>
        </text>
      )}
      {buffer > 0 && (
        <text>
          <span style={{ fg: colors.faint }}>{SYMBOL.buffer} </span>
          <span style={{ fg: colors.text }}>Autocompact buffer: </span>
          <span style={{ fg: colors.muted }}>
            {formatTokens(buffer)} tokens{share(buffer)}
          </span>
        </text>
      )}
    </box>
  )

  const body = (
    // Right padding keeps wrapped text off the scroll bar.
    <box flexDirection="column" gap={1} flexShrink={0} paddingRight={2}>
      <box flexDirection="row" gap={3} flexShrink={0}>
        {rows.length > 0 && (
          <box flexDirection="column" flexShrink={0}>
            {rows.map((row) => (
              <text>
                {row.map((cell) => {
                  const style = cellStyle(cell, colors)
                  return <span style={{ fg: style.color }}>{style.symbol} </span>
                })}
              </text>
            ))}
          </box>
        )}
        {legend}
      </box>

      {(running || data.notes.length > 0) && (
        // Styled like a Markdown quote; the left border runs down every wrapped line.
        <box
          flexDirection="column"
          flexShrink={0}
          gap={1}
          border={["left"]}
          borderStyle="single"
          borderColor={colors.faint}
          paddingLeft={1}
        >
          {running && <text fg={colors.warning}>The session is running; numbers reflect the latest request.</text>}
          {data.notes.map((note) => (
            <text fg={colors.muted}>{note}</text>
          ))}
        </box>
      )}

      {baseline.length > 0 && (
        <box flexDirection="column" flexShrink={0}>
          <Heading colors={colors} title="Baseline" hint={`${formatTokens(baselineTokens)} tokens · sent with every request`} />
          <Tree colors={colors} items={baselineTree(baseline)} />
        </box>
      )}

      {thread && (
        <box flexDirection="column" flexShrink={0}>
          <Heading colors={colors} title={THREAD_LABEL} hint={`${formatTokens(thread.tokens)} tokens · grows with every turn`} />
          <Tree colors={colors} items={sortItems(thread.items)} />
        </box>
      )}

      {glossary.length > 0 && <Glossary colors={colors} terms={glossary} />}
    </box>
  )

  // Dialogs open about a quarter of the way down; keep the scroll area inside the screen.
  const height = Math.max(8, Math.floor((context.renderer.height ?? 40) * 0.75) - 8)

  // Arrow keys scroll the focused box natively; page and jump keys would otherwise reach the session view.
  let scroll: ScrollBoxRenderable | undefined
  context.keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { bind: "pagedown", run: () => scroll?.scrollBy(0.5, "viewport") },
      { bind: "pageup", run: () => scroll?.scrollBy(-0.5, "viewport") },
      { bind: "home", run: () => scroll?.scrollTo(0) },
      { bind: "end", run: () => scroll?.scrollTo(Number.POSITIVE_INFINITY) },
    ],
  }))

  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={colors.text}>
          <b>Context Usage</b>
        </text>
        <text fg={colors.faint}>esc</text>
      </box>
      <scrollbox ref={(element) => (scroll = element)} focused maxHeight={height} scrollY>
        {body}
      </scrollbox>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-context.tui",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-context.show",
          title: "Show context usage",
          description: "Break down what is using the current session's context window",
          group: "Session",
          palette: true,
          slash: { name: "context" },
          run: () => show(context),
        },
      ],
    }))
  },
})
