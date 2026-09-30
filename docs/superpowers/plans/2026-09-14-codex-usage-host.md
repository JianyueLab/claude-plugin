# Codex CLI host 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `jyl-usage` 加第三个 host,把 Codex CLI 的 token 用量报到 llm-web。

**Architecture:** 纯增量 —— 一个新的 `src/hosts/codex.mjs` 实现现成的 13 键 host 契约,
`src/reporter.mjs` 加一个 import + 一个 map 条目,外加一个独立的 `codex-plugin/` 目录
承载 Codex 的 `hooks.json`。**不改 `src/core/` 任何文件。**

**Tech Stack:** 纯 ESM,零依赖,零构建。`bun test`。Node 内置模块 only。

**Spec:** `docs/superpowers/specs/2026-09-14-codex-usage-host-design.md`

## Global Constraints

以下每一条都适用于每个任务,不再逐任务重复:

1. **永不非零退出、永不向 hook 抛异常。** hook 挂掉不该让 Codex 显示错误。
2. **只有计数离开这台机器。** 允许发:token 计数、模型名、时间戳、合成 requestId。
   **禁止发**:文件路径、项目名、分支名、cwd、对话内容、用户输入、模型回复。
3. **零依赖、零构建。** `package.json` 不得长出 `dependencies`。
4. **无密钥、无网络时 `bun test` 必须全绿。**
5. **不改 `src/core/` 任何文件。** 需要改就是设计错了,停下来报告。
6. **`jyl-usage` 现有两个 host 零改动**(`src/hosts/claude-code.mjs`、
   `src/hosts/antigravity.mjs` 及其子模块)。
7. **`jyl-wakatime` 一个字节都不许动**(`src/wakatime/`、`scripts/wakatime`、
   `tests/wakatime-*`、`tests/fixtures/runend.json`)。
8. **不许把真实 rollout 文件当夹具提交** —— 它们含对话内容。夹具一律用代码生成。
9. **不许修改 `~/.codex/` 下任何文件**,除了 T7 里明确授权的一次性目录。
10. **不许跑任何会真的调模型的 codex 命令**(`codex exec` 等)。`--help`/`--version` 可以。
11. 每条新断言配一次变异:改坏生产代码(仍要能跑)→ 跑**整套** `bun test` → 确认红的是
    那一条 → 还原。**还原用字节拷贝 + `cmp` 校验,不要用 `git checkout --`**(脏树上
    会连带抹掉未提交的改动,这个仓真踩过)。
12. 临时文件放 `<repo>/.temp/`,**绝不 `/tmp`**,用完删。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/hosts/codex/parse.mjs`(新) | 纯函数:一份 rollout 的行 → 事件数组。无 I/O,好测。 |
| `src/hosts/codex.mjs`(新) | host 对象:文件定位、增量读、`entry` 游标、状态目录 |
| `src/reporter.mjs`(改,2 行) | 注册 `codex` |
| `codex-plugin/.codex-plugin/plugin.json`(新) | Codex 插件清单 |
| `codex-plugin/hooks.json`(新) | `Stop` → `scripts/run --host codex --detach` |
| `tests/codex-parse.test.js`(新) | 取数与映射的算术 |
| `tests/codex-host.test.js`(新) | 游标、增量读、文件变短、网关跳过 |
| `tests/helpers/rollout.js`(新) | 合成 rollout JSONL 的夹具生成器 |
| `README.md`(改) | 第三个 host 的安装与说明 |

拆成 `parse.mjs` + `codex.mjs` 是因为算术(差分、减 cached、防御分支)是这里唯一会
**算错钱**的部分,把它做成无 I/O 的纯函数,测起来不需要碰文件系统。agy 也是这么拆的
(`antigravity/extract.mjs`)。

---

### Task 1: 夹具生成器

**Files:**
- Create: `tests/helpers/rollout.js`

**Interfaces:**
- Produces: `rollout(lines) -> string`、`meta(id, provider)`、`turnCtx(model)`、
  `tokenCount(total, last, ts)`、`usage(input, cached, output, reasoning)`

- [ ] **Step 1: 写生成器**

真实 rollout 是一行一个 JSON,顶层 `{timestamp, type, payload}`。生成器要能造出
spec §5.1/§5.2 描述的四种 `type`,以及 `info: null` 这种变体。

```js
export const usage = (input, cached, output, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,   // 实测恒等式:total = input + output
});

export const meta = (id, provider = "openai", ts = "2026-09-14T00:00:00.000Z") =>
  ({ timestamp: ts, type: "session_meta", payload: { id, model_provider: provider } });

export const turnCtx = (model, ts = "2026-09-14T00:00:01.000Z") =>
  ({ timestamp: ts, type: "turn_context", payload: { model } });

/** `info: null` 变体:tokenCount(null) —— 实测占 1.79%,必须被跳过 */
export const tokenCount = (total, last, ts = "2026-09-14T00:00:02.000Z") => ({
  timestamp: ts,
  type: "event_msg",
  payload: { type: "token_count", info: total === null ? null : { total_token_usage: total, last_token_usage: last } },
});

export const rollout = (lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
```

- [ ] **Step 2: 提交**

```bash
git add tests/helpers/rollout.js
git commit -m "test(codex): fixture builder for synthetic rollout files"
```

---

### Task 2: 取数与映射的纯函数

**Files:**
- Create: `src/hosts/codex/parse.mjs`
- Test: `tests/codex-parse.test.js`

**Interfaces:**
- Consumes: Task 1 的夹具生成器
- Produces:
  `eventsFrom(lines, state) -> { events, state }`,其中
  `state = { seen, lastTotal, model, sessionId, provider }`,
  `lastTotal = { input, cached, output } | null`

`lines` 是已经 `JSON.parse` 过的对象数组(调用方负责按行解析,这样部分行的处理留在
有 I/O 的那一层)。`state` 进出对称,便于跨多次增量读接续。

- [ ] **Step 1: 先写失败的测试**

这些用例每一条都对应 spec 里一个会算错钱的地方。

```js
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
```

- [ ] **Step 2: 跑,确认全红**

```bash
bun test tests/codex-parse.test.js
```
预期:`Cannot find module '../src/hosts/codex/parse.mjs'`

- [ ] **Step 3: 实现**

注释要写"为什么",尤其那两条防御分支和减 cached 的理由 —— 参照
`src/hosts/antigravity.mjs` 的注释密度。

```js
/**
 * Codex CLI 的 rollout 解析。纯函数,无 I/O。
 *
 * 这里是整条路上唯一会算错钱的地方,所以它不碰文件系统:每一条算术都能用合成
 * 夹具直接钉住。
 */

const PORTAL_PROVIDER = "jianyuelab";   // llm-web 的 /setup 生成器固定写这个 id

const int = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

const totalsOf = (u) => ({ input: int(u?.input_tokens), cached: int(u?.cached_input_tokens), output: int(u?.output_tokens) });

export function eventsFrom(lines, state) {
  let { seen, lastTotal, model, sessionId, provider } = state;
  const events = [];

  for (const line of lines) {
    if (!line || typeof line !== "object") continue;

    if (line.type === "session_meta") {
      if (typeof line.payload?.id === "string") sessionId = line.payload.id;
      if (typeof line.payload?.model_provider === "string") provider = line.payload.model_provider;
      continue;
    }
    if (line.type === "turn_context") {
      if (typeof line.payload?.model === "string" && line.payload.model.trim()) model = line.payload.model.trim();
      continue;
    }
    if (line.type !== "event_msg" || line.payload?.type !== "token_count") continue;

    // 序号按 token_count 记录的位置走,跳过的记录也占位——否则重读时序号错位,
    // 合成的 requestId 会指向另一条记录,去重就失效了。
    const n = seen;
    seen += 1;

    const info = line.payload.info;
    if (!info) continue;                       // 实测 1.79% 是 null

    const total = totalsOf(info.total_token_usage);
    const last = totalsOf(info.last_token_usage);

    let delta;
    if (lastTotal === null) {
      // 首条用 last_token_usage:实测两者相同(20/20),所以零代价;但 resume 的
      // 会话若带着继承来的累计值,total-0 会把继承的那段误报成本次用量。
      delta = last;
    } else if (total.input < lastTotal.input || total.output < lastTotal.output || total.cached < lastTotal.cached) {
      // 回退(/compact 或 resume)。夹到 0 **并重置基准**:只夹不重置的话基准会
      // 永远停在回退前的高位,之后整段用量全部少报,而 --status 一切正常。
      lastTotal = total;
      continue;
    } else {
      delta = { input: total.input - lastTotal.input, cached: total.cached - lastTotal.cached, output: total.output - lastTotal.output };
    }
    lastTotal = total;

    // 走网关的会话:请求经过 /v1 代理时已经计过一次。仍然推进游标,
    // 免得用户中途改配置后把之前那些重报一遍。
    if (provider === PORTAL_PROVIDER) continue;
    if (!model || !sessionId) continue;

    // OpenAI 的 input_tokens 含 cached、output_tokens 含 reasoning;
    // portal 的 inputTokens 与 cacheReadTokens 是两个分别计价的桶,
    // 不减就是把缓存那部分计两遍价。
    const input = Math.max(0, delta.input - delta.cached);
    if (input === 0 && delta.cached === 0 && delta.output === 0) continue;

    events.push({
      requestId: `codex:${sessionId}:${n}`,
      ts: typeof line.timestamp === "string" ? line.timestamp : undefined,
      model,
      inputTokens: input,
      outputTokens: delta.output,
      cacheReadTokens: delta.cached,
      cacheWrite5mTokens: 0,   // OpenAI 的缓存写入不单独计价
      cacheWrite1hTokens: 0,
    });
  }

  return { events, state: { seen, lastTotal, model, sessionId, provider } };
}
```

- [ ] **Step 4: 跑,确认全绿**

```bash
bun test tests/codex-parse.test.js
```

- [ ] **Step 5: 变异验证**

逐条改坏再还原,每条跑**整套** `bun test`,记下红在哪个文件哪一行:

| 变异 | 应该红的 |
|---|---|
| `delta.input - delta.cached` 改成 `delta.input` | input excludes the cached portion |
| output 里把 reasoning 再加一遍(`totalsOf` 本来就不解析 `reasoning_output_tokens`——§5.5 说明它已含在 output 里、不单独上报——所以这条变异要临时把它接进来再加上去) | output keeps reasoning |
| 首条改成 `total - 0` | first token_count uses last_token_usage |
| 回退分支去掉 `lastTotal = total` | a decreasing total is clamped AND rebases |
| `info` 为 null 时 `continue` 放到 `seen += 1` 之前 | info: null still consumes an ordinal |
| 去掉 `provider === PORTAL_PROVIDER` 那条 | a session routed through the portal |
| `model` 在首次设置后不再更新 | the model is the most recent turn_context |

- [ ] **Step 6: 提交**

```bash
git add src/hosts/codex/parse.mjs tests/codex-parse.test.js
git commit -m "feat(codex): parse rollout token_count records into billable events"
```

---

### Task 3: host 对象

**Files:**
- Create: `src/hosts/codex.mjs`
- Test: `tests/codex-host.test.js`

**Interfaces:**
- Consumes: `eventsFrom` from Task 2
- Produces: `export const host`(13 键契约)、`export const roots = { sessions }`(可变,
  供测试重定向)

- [ ] **Step 1: 先写失败的测试**

```js
import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { host, roots } from "../src/hosts/codex.mjs";
import { rollout, meta, turnCtx, tokenCount, usage } from "./helpers/rollout.js";

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-codex-"));
  roots.sessions = path.join(dir, "sessions");     // 绝不碰真实 home
  fs.mkdirSync(path.join(roots.sessions, "2026", "09", "14"), { recursive: true });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (id, lines) => {
  const file = path.join(roots.sessions, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, rollout(lines));
  return file;
};

test("unitsFromHook globs the rollout file by session_id", () => {
  const file = write("aaaa-1111", [meta("aaaa-1111")]);
  expect(host.unitsFromHook({ session_id: "aaaa-1111" })).toEqual([file]);
});

test("unitsFromHook returns nothing when the payload has no session_id", () => {
  expect(host.unitsFromHook({})).toEqual([]);
});

test("read advances the byte offset and only consumes whole lines", () => {
  const file = write("bbbb", [meta("bbbb"), turnCtx("gpt-5.5"), tokenCount(usage(100, 0, 20), usage(100, 0, 20))]);
  const first = host.read(file, {});
  expect(first.events).toHaveLength(1);
  expect(first.entry.offset).toBe(fs.statSync(file).size);

  fs.appendFileSync(file, JSON.stringify(tokenCount(usage(300, 0, 60), usage(200, 0, 40))) + "\n");
  const second = host.read(file, first.entry);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].inputTokens).toBe(200);
});

test("a partial trailing line is not consumed", () => {
  const file = write("cccc", [meta("cccc"), turnCtx("gpt-5.5")]);
  const whole = fs.statSync(file).size;                            // 完整行的字节数
  fs.appendFileSync(file, '{"timestamp":"2026-09-14T00:00:0');     // 半行
  const { entry } = host.read(file, {});
  expect(entry.offset).toBe(whole);                                // 不要硬编半行长度
});

test("a file that shrank resets offset, ordinal AND the diff baseline together", () => {
  // 只重置 offset 会让重读的首条与旧基准做差 → 负差分 → 白记一行日志
  const file = write("dddd", [meta("dddd"), turnCtx("gpt-5.5"), tokenCount(usage(500, 0, 100), usage(500, 0, 100))]);
  const first = host.read(file, {});
  expect(first.events[0].inputTokens).toBe(500);

  write("dddd", [meta("dddd"), turnCtx("gpt-5.5"), tokenCount(usage(70, 0, 14), usage(70, 0, 14))]);
  const second = host.read(file, first.entry);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].inputTokens).toBe(70);
  expect(second.events[0].requestId).toBe("codex:dddd:0");
});

test("a second read whose new lines carry no session_meta still reports", () => {
  // session_meta/turn_context 只在文件开头。不把 model/sessionId/provider 存进 entry,
  // 第一次读正常、之后每次都把事件全丢掉,而 --status 只显示"没有新用量"。
  const file = write("ffff", [meta("ffff"), turnCtx("gpt-5.5"), tokenCount(usage(100, 0, 20), usage(100, 0, 20))]);
  const first = host.read(file, {});
  fs.appendFileSync(file, JSON.stringify(tokenCount(usage(300, 0, 60), usage(200, 0, 40))) + "\n");
  const second = host.read(file, first.entry);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].model).toBe("gpt-5.5");
  expect(second.events[0].requestId).toBe("codex:ffff:1");
});

test("probe reports nothing pending when the file has not grown", () => {
  const file = write("eeee", [meta("eeee")]);
  const entry = { mtimeMs: fs.statSync(file).mtimeMs, offset: fs.statSync(file).size };
  expect(host.probe(file, entry).pending).toBe(0);
});

test("probe returns null for a file that is gone", () => {
  expect(host.probe(path.join(roots.sessions, "nope.jsonl"), {})).toBeNull();
});

test("skipReason is always null — the portal check is per session, in read()", () => {
  expect(host.skipReason({ baseUrl: "https://llm.jianyuelab.net" })).toBeNull();
});

test("the host object satisfies the contract", () => {
  for (const key of ["id", "source", "client", "title", "unitLabel", "stateDir",
                     "unitsFromHook", "recentUnits", "probe", "read", "skipReason", "statusNotes"]) {
    expect(host[key]).toBeDefined();
  }
});
```

- [ ] **Step 2: 跑,确认全红**

- [ ] **Step 3: 实现**

```js
/**
 * Codex CLI → llm-web。
 *
 * 一个"单元"是一份 rollout 文件(`~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<uuid>.jsonl`),
 * 游标是字节偏移 —— 与 Claude Code 那个 host 同类,因为两者都是追加写的 JSONL。
 *
 * **只有计数离开这台机器。** 模型名、时间戳、token 数、合成的 requestId ——
 * 绝不包括 cwd、workspace_roots、对话内容,哪怕 rollout 文件里都有。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventsFrom } from "./codex/parse.mjs";

const CODEX_DIR = path.join(os.homedir(), ".codex");

/** 可变,好让测试指向夹具目录。 */
export const roots = { sessions: path.join(CODEX_DIR, "sessions") };

const walkJsonl = (dir, out = []) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
};

/** 游标的初始状态。文件变短时也回到这里。 */
const fresh = () => ({ offset: 0, seen: 0, lastTotal: null, model: null, sessionId: null, provider: null });

export const host = {
  id: "codex",
  source: "codex",
  client: "codex-usage-reporter/0.4.0",
  title: "jyl-usage — Codex CLI → llm-web usage reporter",
  unitLabel: "session",
  stateDir: path.join(CODEX_DIR, "jyl-usage"),

  // Stop 的载荷给 session_id 但不给文件路径;而 session_meta.payload.id 与文件名
  // 尾部的 uuid 逐字相同(实测 30 份),所以按后缀匹配即可。
  unitsFromHook(hook) {
    const id = typeof hook.session_id === "string" ? hook.session_id : null;
    if (!id) return [];
    return walkJsonl(roots.sessions).filter((f) => path.basename(f, ".jsonl").endsWith(`-${id}`));
  },

  recentUnits(days) {
    const cutoff = Date.now() - days * 86_400_000;
    return walkJsonl(roots.sessions).filter((f) => {
      try {
        return fs.statSync(f).mtimeMs >= cutoff;
      } catch {
        return false; // vanished mid-walk
      }
    });
  },

  probe(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return null;
    }
    const offset = entry.offset ?? 0;
    // 文件变短说明被替换过,整份都要重读。
    const pending = stat.size < offset ? stat.size : stat.size - offset;
    return { mtimeMs: stat.mtimeMs, pending };
  },

  read(unit, entry) {
    let stat;
    try {
      stat = fs.statSync(unit);
    } catch {
      return { events: [], entry: null };
    }

    // 变短 = 轮转或被替换。**三个游标一起回零**:只重置 offset 的话,重读的首条会
    // 与旧的 lastTotal 做差、得到负数,白白撞上回退分支。
    let cur = stat.size < (entry.offset ?? 0) ? fresh() : { ...fresh(), ...entry };
    if (cur.offset === stat.size) return { events: [], entry: { ...cur, mtimeMs: stat.mtimeMs } };

    const fd = fs.openSync(unit, "r");
    let text;
    try {
      const length = stat.size - cur.offset;
      const buf = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buf, 0, length, cur.offset);
      text = buf.subarray(0, read).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }

    // 只消费完整行:Codex 可能正写到一半,越过半行就会丢掉它所属的那次调用。
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline < 0) return { events: [], entry: { ...cur, mtimeMs: stat.mtimeMs } };
    const complete = text.slice(0, lastNewline + 1);

    const lines = [];
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        /* 截断或损坏的一行跳过,不致命 */
      }
    }

    const { events, state } = eventsFrom(lines, cur);
    return {
      events,
      entry: { ...state, offset: cur.offset + Buffer.byteLength(complete, "utf8"), mtimeMs: stat.mtimeMs },
    };
  },

  // 走没走 llm-web 网关是**每个会话**的属性(信号是 session_meta.model_provider),
  // 而 skipReason 是全局开关、只拿得到 reporter 自己的配置。所以那个判断在
  // parse.mjs 里按文件做,这里恒为 null —— 不是漏了。
  skipReason: () => null,

  describePending: (count, totalPending) => `${count} session(s), ${totalPending} byte(s)`,

  statusNotes: () => [
    "",
    "  NOTE: codex --ephemeral writes no session file, so usage from those",
    "        runs cannot be reported at all.",
  ],
};
```

`entry` 形状见 spec §5.4 —— **`model`/`sessionId`/`provider` 必须跟着持久化**,
因为它们来自文件开头的 `session_meta`/`turn_context`,而增量读只看新追加的行。
漏了这三个,第一次读正常、之后每次都把事件全丢掉,而 `--status` 只显示"没有新用量"。

`stateDir` 用 `~/.codex/jyl-usage`(与 agy 用 `~/.gemini/jyl-usage` 同构:跟着被观测的
工具走)。

`describePending` 返回字节数的措辞(Codex 的 `pending` 是字节,和 Claude Code 同类,
不是 agy 那种 0/1 标志)。

`statusNotes` 要说清一件事:**`--ephemeral` 模式不落盘,那条路上的用量无法上报**。

- [ ] **Step 4: 跑,确认全绿**

- [ ] **Step 5: 变异验证**

| 变异 | 应该红的 |
|---|---|
| 变短时只重置 `offset`、不重置 `lastTotal` | a file that shrank resets ... together |
| 消费到最后一个换行之后 | a partial trailing line is not consumed |
| `probe` 用 size 而不是 mtime 比较 | probe reports nothing pending |
| `unitsFromHook` 读 `hook.sessionId` 而不是 `hook.session_id` | unitsFromHook globs ... |
| `read` 返回的 entry 不带 `model`/`sessionId`/`provider` | a second read whose new lines carry no session_meta |

- [ ] **Step 6: 提交**

```bash
git add src/hosts/codex.mjs tests/codex-host.test.js
git commit -m "feat(codex): host adapter over ~/.codex/sessions rollout files"
```

---

### Task 4: 注册 host

**Files:**
- Modify: `src/reporter.mjs`(`HOSTS` 映射附近)

- [ ] **Step 1: 加 import 与映射条目**

```js
import { host as codex } from "./hosts/codex.mjs";
const HOSTS = { "claude-code": claudeCode, antigravity, codex };
```

- [ ] **Step 2: 端到端手验**

```bash
./scripts/run --host codex --status
```
预期:exit 0,标题是 Codex 那行,**不碰真实上报**(没配 baseUrl/apiKey 时显示未配置)。

- [ ] **Step 3: 变异验证**

把 `codex` 从 `HOSTS` 里删掉 → `--host codex` 应该回落到 claude-code。加一条断言钉住
`--host codex` 真的拿到 Codex 那个 host(比对 `host.id`),否则这条注册线无人守。

- [ ] **Step 4: 提交**

```bash
git add src/reporter.mjs tests/
git commit -m "feat(codex): register the codex host"
```

---

### Task 5: Codex 插件目录

**Files:**
- Create: `codex-plugin/.codex-plugin/plugin.json`
- Create: `codex-plugin/hooks.json`

- [ ] **Step 1: 写清单与 hooks**

`hooks.json` 照 spec §8.1 的实测形状。命令用**绝对路径**(插件根是 `codex-plugin/`,
而 `scripts/run` 在上一级;`${CODEX_PLUGIN_ROOT}` 这类变量未经证实)。文件里放一个占位的
绝对路径,README 让用户替换成自己的 checkout。

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "/ABSOLUTE/PATH/TO/harness-plugin/scripts/run --host codex --detach" } ] }
    ]
  }
}
```

- [ ] **Step 2: 加一条测试,钉住这个文件不会被写成 agy 的形状**

三个 hooks 清单三种格式,放错会静默不触发。断言 `codex-plugin/hooks.json` 有顶层
`hooks` 键、`hooks.Stop` 是数组、元素里有 `hooks` 数组、命令含 `--host codex`。

- [ ] **Step 3: 提交**

```bash
git add codex-plugin/
git commit -m "feat(codex): ship the Codex plugin manifest and Stop hook"
```

---

### Task 6: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 写第三个 host 那一节**

照 "How it works (agy)" 那节的形状。必须写到的几件事:

- 安装:插件目录 + 绝对路径替换
- **`Stop` 默认阻塞**,所以命令带 `--detach`
- **走 llm-web 网关的会话会被跳过**,信号是 `session_meta.model_provider`
  等于 `jianyuelab`;**用户手改 provider id 就会漏判**,那会导致同一批 token 记两遍
- **`--ephemeral` 模式的用量无法上报**(那个模式刻意不落盘)
- 发什么/不发什么的清单里加上 Codex 这一路

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: cover the Codex host, its gateway skip and its two known gaps"
```

---

### Task 7: 对着真 Codex 验证(**要用户点头才能跑**)

前六个任务全部靠合成夹具。这一条是唯一会碰真实 Codex 的任务,而这个仓已经吃过一次亏:
`jyl-wakatime` 所有基于夹具的验证都是绿的,而它在作者机器上会**永远静默什么都不做** ——
只有拿真配置跑一次才发现。

**必须先拿到用户明确同意**,因为它要往 Codex 里装一个插件、并跑一轮真实对话(花钱)。

- [ ] **Step 1: 确认插件安装途径**

spec §9.5 未定。本机插件在 `~/.codex/.tmp/plugins/plugins/<name>/`,那个 `.tmp` 像内部
暂存区。先查有没有 `codex plugin` 一类子命令(`codex --help`,不花钱),再决定装法。
**查不到就如实报告,不要往 `.tmp` 里硬塞。**

- [ ] **Step 2: 装插件,跑一轮最小对话**

- [ ] **Step 3: 核对**

- hook 有没有真的被触发(看 `~/.codex/jyl-usage/log`)
- `--status` 的数字对不对
- 上报的 token 数与 rollout 文件里那一轮的 `total_token_usage` 增量**对得上**
- Codex 的 TUI 有没有因为 hook 而卡顿或报错

- [ ] **Step 4: 收拾**

把插件从 Codex 里移除,`~/.codex/` 恢复原状,报告里写明恢复前后的核对方式。

- [ ] **Step 5: 把发现写进 spec,提交**
