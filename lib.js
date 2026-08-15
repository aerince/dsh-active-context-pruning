/** Pure helpers for dsh-active-context-pruning. No DSH imports. */

export function parseLimit(raw) {
  const text = String(raw).trim()
  if (text.endsWith("%")) {
    const value = Number(text.slice(0, -1))
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw new Error(`invalid limit ${JSON.stringify(raw)}`)
    }
    return { kind: "ratio", value: value / 100 }
  }
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid limit ${JSON.stringify(raw)}`)
  }
  return { kind: "tokens", value }
}

export function parseSeq(raw) {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) return raw
  const text = String(raw).trim().replace(/^[sS]/, "")
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid seq ${JSON.stringify(raw)}`)
  }
  return value
}

export function thresholdTokens(limit, windowTokens) {
  if (limit.kind === "tokens") return limit.value
  if (windowTokens == null) return null
  return Math.floor(windowTokens * limit.value)
}

export function pressureLevel(used, minTokens, maxTokens) {
  if (minTokens == null) return "none"
  if (maxTokens != null && used >= maxTokens) return "hard"
  if (used >= minTokens) return "soft"
  return "none"
}

export function preview(text, max = 80) {
  const compact = String(text).replace(/\s+/g, " ").trim()
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(0, max - 1))}…`
}

export function blockText(block) {
  if (block == null || typeof block !== "object") return ""
  if (typeof block.text === "string") return block.text
  if (block.type === "tool-call") {
    return `${block.name ?? ""} ${typeof block.arguments === "string" ? block.arguments : ""}`.trim()
  }
  return ""
}

export function eventText(event) {
  if (event == null || typeof event !== "object") return ""
  if (event.type === "compaction/summary") {
    const summary = event.data?.summary
    if (typeof summary === "string") return summary
    if (Array.isArray(summary)) return summary.map(blockText).join("\n")
  }
  const content = event.type === "user/message"
    ? event.data?.content
    : event.type === "assistant/message" || event.type === "tool/result"
      ? event.data?.message?.content
      : null
  if (!Array.isArray(content)) return ""
  return content.map(blockText).join("\n")
}

export function isCheckpointEvent(event) {
  return event?.type === "user/message"
    && event.data?.source?.kind === "plugin"
    && event.data.source.plugin === "compact"
}

export function searchEvents(events, query, limit = 10) {
  const needle = String(query).trim().toLowerCase()
  if (!needle || limit <= 0) return []
  const hits = []
  for (const event of events) {
    const text = eventText(event)
    const at = text.toLowerCase().indexOf(needle)
    if (at < 0) continue
    const start = Math.max(0, at - 40)
    hits.push({
      seq: event.seq,
      type: event.type,
      surface: event.surfaceOp != null,
      snippet: preview(text.slice(start, at + needle.length + 80), 160),
    })
    if (hits.length >= limit) break
  }
  return hits
}

export function formatStatus({ used, windowTokens, minTokens, maxTokens, level, nodes, checkpoints }) {
  const pct = windowTokens ? `${Math.round((used / windowTokens) * 1000) / 10}%` : "n/a"
  const lines = [
    `usage: ${used} / ${windowTokens ?? "unknown"} (${pct})`,
    `nudge: ${level}  min=${minTokens ?? "n/a"}  max=${maxTokens ?? "n/a"}`,
    `surface: ${nodes.length} nodes`,
    "",
    "id  type                  tokens  preview",
  ]
  for (const node of nodes) {
    const mark = node.checkpoint ? "*" : " "
    lines.push(`${String(node.seq).padStart(4)}${mark} ${node.type.padEnd(20)} ${String(node.tokens).padStart(6)}  ${node.preview}`)
  }
  if (checkpoints.length > 0) {
    lines.push("", "checkpoints (*):")
    for (const item of checkpoints) {
      lines.push(`  seq ${item.seq}  replaced ${item.start}-${item.end}  shadowed ${item.shadowed}`)
    }
  }
  return lines.join("\n")
}
