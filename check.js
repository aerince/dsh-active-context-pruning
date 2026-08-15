import assert from "node:assert/strict"
import {
  parseLimit,
  parseSeq,
  thresholdTokens,
  pressureLevel,
  preview,
  eventText,
  isCheckpointEvent,
  searchEvents,
  formatStatus,
} from "./lib.js"

assert.deepEqual(parseLimit("60%"), { kind: "ratio", value: 0.6 })
assert.deepEqual(parseLimit("154000"), { kind: "tokens", value: 154000 })
assert.equal(parseSeq("s12"), 12)
assert.equal(parseSeq(7), 7)
assert.equal(thresholdTokens({ kind: "ratio", value: 0.7 }, 1000), 700)
assert.equal(pressureLevel(500, 600, 700), "none")
assert.equal(pressureLevel(650, 600, 700), "soft")
assert.equal(pressureLevel(700, 600, 700), "hard")
assert.equal(preview("a  b\nc", 3), "a …")

const events = [
  {
    seq: 2,
    type: "user/message",
    surfaceOp: "append",
    data: {
      content: [{ type: "text", text: "fix the auth token refresh" }],
      source: { kind: "user" },
    },
  },
  {
    seq: 8,
    type: "compaction/summary",
    data: {
      summary: [{ type: "text", text: "auth refresh is done" }],
      shadowedRange: { start: 1, end: 4 },
    },
  },
  {
    seq: 9,
    type: "user/message",
    data: {
      content: [{ type: "text", text: "checkpoint" }],
      source: { kind: "plugin", plugin: "compact", compactionId: "x" },
    },
  },
]

assert.equal(isCheckpointEvent(events[2]), true)
assert.equal(eventText(events[0]).includes("auth token"), true)
assert.equal(searchEvents(events, "auth", 5).length, 2)
assert.match(formatStatus({
  used: 800,
  windowTokens: 1000,
  minTokens: 600,
  maxTokens: 700,
  level: "hard",
  nodes: [{ seq: 9, type: "user/message", tokens: 40, preview: "checkpoint", checkpoint: true }],
  checkpoints: [{ seq: 9, start: 1, end: 4, shadowed: 4 }],
}), /80%/)

console.log("ok")
