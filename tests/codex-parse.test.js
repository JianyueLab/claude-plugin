import { test, expect } from "bun:test";
import { eventsFrom } from "../src/hosts/codex/parse.mjs";
import { meta, turnCtx, tokenCount, usage } from "./helpers/rollout.js";

const S0 = { seen: 0, lastTotal: null, model: null, sessionId: null, provider: null };
const parse = (lines, state = S0) => eventsFrom(lines, state);

test("first token_count uses last_token_usage, not total minus zero", () => {
  // resume 的会话首条 total 带着继承来的累计值;用 total-0 会把继承的那段误报
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(usage(9000, 0, 500), usage(100, 0, 20)),
  ]);
  expect(events).toHaveLength(1);
  expect(events[0].inputTokens).toBe(100);
  expect(events[0].outputTokens).toBe(20);
});

test("input excludes the cached portion, output keeps reasoning", () => {
  // OpenAI 的 input_tokens 含 cached、output_tokens 含 reasoning;
  // portal 的 inputTokens 与 cacheReadTokens 是两个分别计价的桶
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(usage(100, 40, 30, 12), usage(100, 40, 30, 12)),
  ]);
  expect(events[0].inputTokens).toBe(60);        // 100 - 40,不是 100
  expect(events[0].cacheReadTokens).toBe(40);
  expect(events[0].outputTokens).toBe(30);       // 不是 30 + 12
  expect(events[0].cacheWrite5mTokens).toBe(0);
  expect(events[0].cacheWrite1hTokens).toBe(0);
});

test("a duplicated token_count produces no second event", () => {
  // 实测 47.5% 的记录与前一条逐字节相同;差分为 0,全零事件被丢弃
  const t = usage(100, 0, 20);
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(t, t), tokenCount(t, t),
  ]);
  expect(events).toHaveLength(1);
});

test("subsequent events are the difference of the cumulative total", () => {
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(usage(100, 0, 20), usage(100, 0, 20)),
    tokenCount(usage(260, 50, 45), usage(160, 50, 25)),
  ]);
  expect(events).toHaveLength(2);
  expect(events[1].inputTokens).toBe(110);   // (260-100) - (50-0)
  expect(events[1].cacheReadTokens).toBe(50);
  expect(events[1].outputTokens).toBe(25);
});

test("a decreasing total is clamped AND rebases, so the next event is not under-reported", () => {
  // 只夹不重置的实现会在最后一条上红:基准停在高位,之后整段永久少报
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(usage(1000, 0, 200), usage(1000, 0, 200)),
    tokenCount(usage(50, 0, 10), usage(50, 0, 10)),      // 回退
    tokenCount(usage(90, 0, 18), usage(40, 0, 8)),
  ]);
  expect(events).toHaveLength(2);            // 回退那条被夹成全零,丢弃
  expect(events[1].inputTokens).toBe(40);    // 90 - 50,不是 90 - 1000
  expect(events[1].outputTokens).toBe(8);
});

test("info: null is skipped but still consumes an ordinal", () => {
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(null),
    tokenCount(usage(100, 0, 20), usage(100, 0, 20)),
  ]);
  expect(events).toHaveLength(1);
  expect(events[0].requestId).toBe("codex:s1:1");   // 不是 :0
});

test("the model is the most recent turn_context, not the first", () => {
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(usage(100, 0, 20), usage(100, 0, 20)),
    turnCtx("gpt-5.5-codex"),
    tokenCount(usage(200, 0, 40), usage(100, 0, 20)),
  ]);
  expect(events[0].model).toBe("gpt-5.5");
  expect(events[1].model).toBe("gpt-5.5-codex");
});

test("a session routed through the portal yields no events", () => {
  // 走网关的会话在 /v1 代理路上已经计过费;再报一次就是同一批 token 记两遍
  const { events } = parse([
    meta("s1", "jianyuelab"), turnCtx("gpt-5.5"),
    tokenCount(usage(100, 0, 20), usage(100, 0, 20)),
  ]);
  expect(events).toHaveLength(0);
});

test("state carries across calls so a second read continues the diff", () => {
  const first = parse([meta("s1"), turnCtx("gpt-5.5"), tokenCount(usage(100, 0, 20), usage(100, 0, 20))]);
  const second = eventsFrom([tokenCount(usage(300, 0, 60), usage(200, 0, 40))], first.state);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].inputTokens).toBe(200);
  expect(second.events[0].requestId).toBe("codex:s1:1");
});

test("ts comes from the record, never from now()", () => {
  const { events } = parse([
    meta("s1"), turnCtx("gpt-5.5"),
    tokenCount(usage(100, 0, 20), usage(100, 0, 20), "2026-09-01T12:00:00.000Z"),
  ]);
  expect(events[0].ts).toBe("2026-09-01T12:00:00.000Z");
});
