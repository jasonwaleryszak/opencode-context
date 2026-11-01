import { Rpc } from "@opencode/plugin/rpc"

export type CategoryID = "system" | "tools" | "mcp" | "instructions" | "skills" | "messages" | "other"

/**
 * Categories sent the same way with every request, whatever the conversation holds: the baseline a
 * new session starts with. Everything else belongs to the thread and grows with it.
 */
export const BASELINE: ReadonlySet<CategoryID> = new Set(["system", "tools", "mcp", "instructions", "skills"])

export interface Item {
  readonly name: string
  readonly tokens: number
  readonly detail?: string
  /** Shared text that belongs to the category but not to any one item, such as wrapper markup. Listed last. */
  readonly overhead?: boolean
  /** Breakdown of this item; their tokens add up to the item's. */
  readonly children?: readonly Item[]
}

export interface Category {
  readonly id: CategoryID
  readonly label: string
  readonly tokens: number
  readonly items: readonly Item[]
}

export interface ModelSummary {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
  readonly name?: string
  readonly limit?: { readonly context: number; readonly input?: number; readonly output: number }
}

export interface ReportedUsage {
  /** Prompt tokens of the last completed request: input + cache read + cache write. */
  readonly prompt: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly at: number
}

export interface Breakdown {
  readonly sessionID: string
  /**
   * - `captured`: categories come from a request the plugin observed.
   * - `usage-only`: no request was observed yet; only provider-reported totals are known.
   * - `empty`: nothing is known about this session yet.
   */
  readonly status: "captured" | "usage-only" | "empty"
  readonly capturedAt?: number
  readonly agent?: string
  readonly model?: ModelSummary
  readonly categories: readonly Category[]
  /** Tokens currently in context: sum of every category. */
  readonly total: number
  readonly reported?: ReportedUsage
  /** Factor applied to the character-based estimates so they match the provider-reported prompt size. */
  readonly calibration?: number
  readonly notes: readonly string[]
}

export interface BreakdownInput {
  /** Omit for a session that has not been created yet; the result then shows only fixed overhead. */
  readonly sessionID?: string
  /**
   * Agent a session that has not been created yet will use, so its baseline comes from a request by
   * that agent. For RPC clients that know it; the TUI can't read the prompt's selected agent, so it
   * omits this.
   */
  readonly agent?: string
}

export const ContextRpc = Rpc.define({
  id: "opencode-context",
  methods: {
    breakdown: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, agent: { type: "string" } },
        additionalProperties: false,
      },
      output: { type: "object" },
    },
  },
  events: {},
})
