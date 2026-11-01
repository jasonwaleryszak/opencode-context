import type { Category, CategoryID } from "./rpc.js"

export function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(tokens))
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${trim(value / 1_000)}k`
  return `${trim(value / 1_000_000)}M`
}

function trim(value: number) {
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(1)
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed
}

export function formatPercent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%"
  const value = (part / whole) * 100
  if (value < 0.1) return "<0.1%"
  return `${value.toFixed(1)}%`
}

export interface CompactionSettings {
  readonly auto: boolean
  readonly buffer?: string | number
}

const DEFAULT_BUFFER = 0.15
const MIN_DEFAULT_BUFFER = 16_000

/** Tokens kept free before automatic compaction starts, following OpenCode's `compaction.buffer` rules. */
export function bufferTokens(limit: number, settings: CompactionSettings): number {
  if (!settings.auto || limit <= 0) return 0
  const fallback = Math.min(Math.max(Math.round(limit * DEFAULT_BUFFER), MIN_DEFAULT_BUFFER), limit)
  const buffer = settings.buffer
  if (typeof buffer === "number") return buffer > 0 && buffer < limit ? Math.round(buffer) : fallback
  if (typeof buffer === "string") {
    const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(buffer)
    const share = match ? Number(match[1]) : NaN
    if (share >= 1 && share <= 99) return Math.round((limit * share) / 100)
  }
  return fallback
}

export type Cell =
  | { readonly kind: "used"; readonly category: CategoryID; readonly partial: boolean }
  | { readonly kind: "free" | "buffer" }

/**
 * Lays the context window out as `size` cells. Every category with tokens gets at least one cell so
 * it stays visible, marked `partial` when it fills less than a cell; the remaining cells are split by
 * largest remainder.
 */
export function layoutGrid(categories: readonly Category[], limit: number, buffer: number, size = 100): Cell[] {
  if (limit <= 0) return []
  const cell = limit / size
  const used = categories.filter((category) => category.tokens > 0)
  const exact = used.map((category) => category.tokens / cell)
  const counts = exact.map((value) => Math.max(1, Math.floor(value)))
  const target = Math.min(
    size,
    Math.max(
      counts.reduce((sum, count) => sum + count, 0),
      Math.round(exact.reduce((sum, value) => sum + value, 0)),
    ),
  )
  let assigned = counts.reduce((sum, count) => sum + count, 0)
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder)
  for (const { index } of order) {
    if (assigned >= target) break
    if (exact[index]! < 1) continue
    counts[index]!++
    assigned++
  }
  // Too many tiny categories for the grid: trim from the largest.
  while (assigned > size) {
    const largest = counts.indexOf(Math.max(...counts))
    counts[largest]!--
    assigned--
  }

  const cells: Cell[] = []
  used.forEach((category, index) => {
    const partial = exact[index]! < 0.75
    for (let i = 0; i < counts[index]!; i++) cells.push({ kind: "used", category: category.id, partial })
  })
  const bufferCells = Math.min(Math.round(buffer / cell), size - cells.length)
  const freeCells = size - cells.length - bufferCells
  for (let i = 0; i < freeCells; i++) cells.push({ kind: "free" })
  for (let i = 0; i < bufferCells; i++) cells.push({ kind: "buffer" })
  return cells
}
