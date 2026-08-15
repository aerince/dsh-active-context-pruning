import z from "@deepseek-ai/schemastery"
import { defineTool } from "@deepseek-ai/dsh-tools"
import {
  eventText,
  formatStatus,
  isCheckpointEvent,
  parseLimit,
  parseSeq,
  preview,
  pressureLevel,
  searchEvents,
  thresholdTokens,
} from "./lib.js"

export const name = "active-context-pruning"

export const inject = ["tools"]

export const Config = z.object({
  enabled: z.boolean().default(true),
  minContextLimit: z.string().default("60%"),
  maxContextLimit: z.string().default("70%"),
  preserveRecent: z.number().default(2),
  minTokens: z.number().default(200),
  nudge: z.boolean().default(true),
})

const SECTION = `Active Context Pruning (ACP) is available. History is hidden by replacing a surface range with your summary — not by hard truncation.

Use surface seq ids from the ACP runtime context or acp_status. Never compress the newest preserve-recent tail (it includes the live tool call).

When usage crosses the soft limit, call acp_compress on spent exploration/tool dumps. When it crosses the hard limit, compress before any other work.

acp_compress summary rules: dense bullets; keep paths, signatures, error strings, numbers, decisions and why; drop consumed logs. The next turn only sees that summary.

acp_decompress returns the original hidden text for this turn; it does not restore the surface.

This is not Agent Client Protocol.`

const SOFT = "ACP: context is past the soft limit. Compress spent ranges with acp_compress before continuing."
const HARD = "ACP: context is past the hard limit. Call acp_compress now. Do not start new exploration."

function requireAgent(exec) {
  if (exec?.agent?.session == null) throw new Error("ACP tools need an active agent session")
  return exec.agent
}

function requireCompaction(ctx) {
  const compaction = ctx.get("compaction")
  if (compaction == null || typeof compaction.compactRegion !== "function") {
    throw new Error("ACP compress needs ctx.compaction (load @deepseek-ai/dsh-compaction-basic)")
  }
  return compaction
}

function listCheckpoints(session) {
  const items = []
  for (const event of session.events) {
    if (event.type !== "compaction/summary") continue
    items.push({
      seq: event.seq,
      start: event.data.shadowedRange.start,
      end: event.data.shadowedRange.end,
      shadowed: event.data.shadowedSeqs?.length ?? 0,
    })
  }
  return items
}

function surfaceNodes(ctx, session) {
  const priced = new Map((ctx.get("tokenMeter")?.measure(session).nodes ?? []).map((node) => [node.seq, node.tokens]))
  return session.surface.nodes.map((seq) => {
    const event = session.events[seq]
    return {
      seq,
      type: event?.type ?? "unknown",
      tokens: priced.get(seq) ?? 0,
      preview: preview(eventText(event), 72),
      checkpoint: isCheckpointEvent(event),
    }
  })
}

async function resolveWindow(ctx, agent) {
  const header = agent.session.requestHeader()?.config
  const provider = header?.provider || agent.options?.provider
  const model = header?.model || agent.options?.model
  const llm = ctx.get("llm")
  if (llm == null || !provider || !model) return
  try {
    const info = await llm.resolveModelInfo(provider, model)
    return info?.context?.contextWindow
  } catch {
    return
  }
}

function usageReport(ctx, agent, config, windowTokens) {
  const used = ctx.get("tokenMeter")?.measure(agent.session).totalTokens ?? 0
  const min = parseLimit(config.minContextLimit)
  const max = parseLimit(config.maxContextLimit)
  const minTokens = thresholdTokens(min, windowTokens)
  const maxTokens = thresholdTokens(max, windowTokens)
  return {
    used,
    windowTokens,
    minTokens,
    maxTokens,
    level: pressureLevel(used, minTokens, maxTokens),
    nodes: surfaceNodes(ctx, agent.session),
    checkpoints: listCheckpoints(agent.session),
  }
}

function renderStatus(ctx, agent, config, windowTokens) {
  return formatStatus(usageReport(ctx, agent, config, windowTokens))
}

function assertSafeRange(session, start, end, config) {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx < 0) throw new Error(`start seq ${start} is not on the current surface`)
  if (endIdx < 0) throw new Error(`end seq ${end} is not on the current surface`)
  if (startIdx > endIdx) throw new Error(`start seq ${start} is after end seq ${end} on the surface`)
  const lastAllowed = nodes.length - 1 - config.preserveRecent
  if (endIdx > lastAllowed) {
    throw new Error(`cannot compress the last ${config.preserveRecent} surface node(s); end must be seq ${nodes[lastAllowed] ?? "n/a"} or earlier`)
  }
}

function findSummary(session, start, end, seq) {
  if (seq != null) {
    const event = session.events[seq]
    if (isCheckpointEvent(event)) {
      const id = event.data.source.compactionId
      return [...session.events].reverse().find((item) => item.type === "compaction/summary" && item.data?.compactionId === id)
        ?? [...session.events].reverse().find((item) => item.type === "compaction/summary" && item.data?.shadowedRange && item.seq < seq)
    }
    if (event?.type === "compaction/summary") return event
  }
  return [...session.events].reverse().find((item) => (
    item.type === "compaction/summary"
    && item.data?.shadowedRange?.start === start
    && item.data?.shadowedRange?.end === end
  ))
}

function hiddenText(session, summary) {
  const seqs = summary.data.shadowedSeqs ?? []
  const parts = []
  for (const seq of seqs) {
    const event = session.events[seq]
    if (event == null) continue
    parts.push(`# s${seq} ${event.type}\n${eventText(event)}`)
  }
  return parts.join("\n\n") || "(empty)"
}

function installSummaryHook(ctx, pending) {
  const compaction = ctx.get("compaction")
  if (compaction == null || typeof compaction.summarize !== "function") return () => {}
  const original = compaction.summarize.bind(compaction)
  compaction.summarize = async (input, agent, signal) => {
    const summary = pending.get(agent.session)
    if (summary != null) {
      pending.delete(agent.session)
      return {
        summary: [{ type: "text", text: summary }],
        provider: "acp",
        model: "model-authored",
      }
    }
    return original(input, agent, signal)
  }
  return () => {
    compaction.summarize = original
  }
}

function registerTools(ctx, config, pending, windows) {
  ctx.tools.register(defineTool({
    name: "acp_status",
    description: "Show ACP usage, surface seq map, and compaction checkpoints.",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      return renderStatus(ctx, agent, config, windows.get(agent.session) ?? await resolveWindow(ctx, agent))
    },
  }))

  ctx.tools.register(defineTool({
    name: "acp_compress",
    description: "Replace an inclusive surface seq range with your summary. The original events stay in the log but leave the next model request. Range must be tool-pairing balanced and must not include the newest tail.",
    parameters: {
      start: { type: "integer", required: true, description: "Inclusive first surface seq" },
      end: { type: "integer", required: true, description: "Inclusive last surface seq" },
      summary: { type: "string", required: true, description: "Dense checkpoint the next turn will see instead of this range" },
      topic: { type: "string", description: "Short label" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const compaction = requireCompaction(ctx)
      const start = parseSeq(args.start)
      const end = parseSeq(args.end)
      const summary = String(args.summary ?? "").trim()
      if (!summary) throw new Error("summary is required")
      assertSafeRange(agent.session, start, end, config)
      const meter = ctx.get("tokenMeter")
      if (meter != null) {
        const selected = meter.measure(agent.session).nodes.filter((node) => {
          const idx = agent.session.surface.nodes.indexOf(node.seq)
          const a = agent.session.surface.nodes.indexOf(start)
          const b = agent.session.surface.nodes.indexOf(end)
          return idx >= a && idx <= b
        })
        const tokens = selected.reduce((sum, node) => sum + node.tokens, 0)
        if (tokens < config.minTokens) throw new Error(`range is only ~${tokens} tokens; minTokens is ${config.minTokens}`)
      }
      pending.set(agent.session, summary)
      try {
        const result = await compaction.compactRegion(start, end, agent, exec.signal)
        const topic = args.topic ? ` (${args.topic})` : ""
        return `compressed${topic} ${result.shadowedRange.start}-${result.shadowedRange.end}: ${result.shadowedSeqs.length} nodes, ~${result.shadowedTokenCount} tokens`
      } catch (error) {
        pending.delete(agent.session)
        throw error
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: "acp_decompress",
    description: "Return the original text hidden by a compaction checkpoint. Does not restore the surface.",
    parameters: {
      seq: { type: "integer", description: "Checkpoint surface seq or compaction/summary seq" },
      start: { type: "integer", description: "Original shadowed start seq" },
      end: { type: "integer", description: "Original shadowed end seq" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const seq = args.seq == null ? null : parseSeq(args.seq)
      const start = args.start == null ? null : parseSeq(args.start)
      const end = args.end == null ? null : parseSeq(args.end)
      const summary = findSummary(agent.session, start, end, seq)
      if (summary == null) throw new Error("no compaction checkpoint matches seq/start/end")
      const range = summary.data.shadowedRange
      return `restored s${range.start}-s${range.end} (read-only)\n\n${hiddenText(agent.session, summary)}`
    },
  }))

  ctx.tools.register(defineTool({
    name: "acp_search",
    description: "Search visible surface events and hidden compacted originals.",
    parameters: {
      query: { type: "string", required: true, description: "Case-insensitive substring" },
      limit: { type: "integer", description: "Max hits (default 10)" },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const agent = requireAgent(exec)
      const hits = searchEvents(agent.session.events, args.query, args.limit ?? 10)
      if (hits.length === 0) return `no hits for ${JSON.stringify(args.query)}`
      return hits.map((hit) => `s${hit.seq} ${hit.type}${hit.surface ? "" : " (hidden)"}\n  ${hit.snippet}`).join("\n")
    },
  }))
}

function resolveConfig(config = {}) {
  return {
    enabled: config.enabled ?? true,
    minContextLimit: config.minContextLimit ?? "60%",
    maxContextLimit: config.maxContextLimit ?? "70%",
    preserveRecent: config.preserveRecent ?? 2,
    minTokens: config.minTokens ?? 200,
    nudge: config.nudge ?? true,
  }
}

export function apply(ctx, config) {
  config = resolveConfig(config)
  if (!config.enabled) return

  const pending = new WeakMap()
  const windows = new WeakMap()

  ctx.effect(() => installSummaryHook(ctx, pending))

  ctx.on("agent/pre-step", async ({ agent }, next) => {
    const windowTokens = await resolveWindow(ctx, agent)
    if (windowTokens != null) windows.set(agent.session, windowTokens)
    return next()
  })

  const systemPrompt = ctx.get("systemPrompt")
  if (systemPrompt != null) {
    systemPrompt.section({
      name: "acp:instructions",
      order: 80,
      text: SECTION,
    })
    systemPrompt.context({
      name: "acp:surface",
      order: 80,
      text: (assembly) => {
        const agent = assembly.agent
        if (agent?.session == null) return ""
        const report = usageReport(ctx, agent, config, windows.get(agent.session))
        const body = renderStatus(ctx, agent, config, windows.get(agent.session))
        if (!config.nudge || report.level === "none") {
          return `ACP surface map. Use these seq ids with acp_compress.\n\n${body}`
        }
        const banner = report.level === "hard" ? HARD : SOFT
        return `${banner}\n\n${body}`
      },
    })
  }

  const commands = ctx.get("commands")
  if (commands != null) {
    commands.register({
      name: "acp",
      description: "Show Active Context Pruning status",
      async handler(invocation) {
        const windowTokens = windows.get(invocation.agent.session) ?? await resolveWindow(ctx, invocation.agent)
        return { kind: "success", text: renderStatus(ctx, invocation.agent, config, windowTokens) }
      },
    })
  }

  registerTools(ctx, config, pending, windows)
}
