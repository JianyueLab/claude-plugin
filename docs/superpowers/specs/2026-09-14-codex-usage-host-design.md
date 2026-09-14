# jyl-usage 的第三个 host:Codex CLI

**日期:** 2026-09-14
**状态:** 设计已定,四条关键事实**已在本机真实数据上验完**(§9.1–§9.4);
剩余待定项是安装面与检测形状(§9.5–§9.9),不阻塞实现

## 1. 目标

让 OpenAI 的 **Codex CLI** 跑掉的 token 出现在 llm-web 的用量里,途径是给现有的
`jyl-usage` 上报器加**第三个 host**,而不是新开一个工具。

Claude Code 和 Antigravity CLI 已经在里面。Codex 是第三个。

## 2. 为什么是 host 而不是新工具

`jyl-usage` 对外的承诺是一句话:**只有计数离开这台机器。** Codex 这条路发出去的东西
与另外两个 host 完全同类 —— token 计数、模型名、时间戳、合成的请求 id ——
所以它落在那句承诺里面,不需要像 `jyl-wakatime` 那样另立门户(那个工具必须分出去,
因为 WakaTime 的 `entity` 字段**就是**文件绝对路径)。

**不发**:文件路径、项目名、分支名、对话内容、用户输入、模型回复、cwd。

`cwd` 值得单独点一句:Codex 的 hook 载荷里**有** `cwd`,`turn_context` 里也有。
它不进上报载荷。载荷字段表(§5)是白名单,不是"除了这些之外都行"。

## 3. 抽象层已经存在,这次是纯增量

PR #2(加 Antigravity 那次)顺手把 host 抽象从 `reporter.mjs` 里拆了出来,所以:

- **不改 `src/core/` 任何文件。** 锁、补扫、去重窗口、spool、保留期都是 host 无关的。
- 新增一个 `src/hosts/codex.mjs`,实现 13 个键的契约(`tests/report.test.js` 里那个
  `fakeHost` 是它的可执行文档)。
- 注册就是 `src/reporter.mjs` 里**一个 import + 一个 map 条目**。

如果实现期发现必须改 `src/core/`,那就是设计错了,停下来重新审。

## 4. 触发:Codex 的新 hooks 机制,`Stop` 事件

Codex 有**两套**回调机制,这里选新的那套。

| | 旧 `notify` | 新 `hooks` ← 选这个 |
|---|---|---|
| 载荷怎么递 | 整段 JSON 作为**单个 argv 参数** | **stdin** |
| 事件 | 只有 `agent-turn-complete` | 十二个,含 `Stop`、`SessionEnd` |
| 内部模块名 | `legacy_notify` | — |

选新的理由是形状对得上,不是新旧偏好:契约里的 `unitsFromHook(payload)` 和
`scripts/run --detach` **本来就是读 stdin 的**,旧机制要另写一条 argv 转接路径。
模块名里那个 `legacy` 也不值得押注(官方尚未标注废弃,但方向明显)。

**用 `Stop`(一轮结束),不用 `SessionEnd`。** `SessionEnd` 直接给
`transcript_path`,省一次 glob,听起来更省事 —— 但它要等整个会话结束或闲置 30 分钟
才触发,那时候这一轮的用量已经晚了几十分钟。补扫机制(`src/core/report.mjs` 里现成的)
足以兜住漏掉的 `Stop`,所以不为了省一次 glob 牺牲及时性。

**照 agy 的做法走 `--detach`。** Codex 的 hook 是否阻塞 agent 循环未经证实
(§9.6),而载荷里那个 `stop_hook_active` 字段说明它至少能循环。`--detach` 是现成的、
在 agy 那条路上已经服役,且在非阻塞的情况下也没有坏处。

### 4.1 hook 载荷里没有 token 数字

`Stop` 的载荷(文档):`session_id, turn_id, cwd, hook_event_name, model,
permission_mode, stop_hook_active, last_assistant_message`。

**没有一个 usage 字段。** 所以 hook 只是"时机信号",用量必须自己去会话记录里读。
这一点与 Claude Code 那条路同构(那边也是 hook 给信号、reporter 读 transcript)。

## 5. 会话记录与取数

### 5.1 文件定位(实测)

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO时间戳>-<uuid>.jsonl
```

一行一个 JSON 对象,顶层恒为 `timestamp` + `type` + `payload`。`type` 实测四种:
`session_meta`、`turn_context`、`event_msg`、`response_item`。

**`session_meta.payload.id` 与文件名尾部那串 uuid 逐字相同**(30 份样本全部核对过),
所以 `Stop` 给的 `session_id` 可以直接 glob:

```
~/.codex/sessions/**/rollout-*-<session_id>.jsonl
```

会话跨午夜不会分文件 —— 目录是按创建时间落的,所以一个 session 只有一个文件。

### 5.2 用量记录(实测)

`event_msg` 里 `payload.type == "token_count"` 的记录,`payload.info` 下两块,
字段相同:

| | 含义 |
|---|---|
| `total_token_usage` | **累计**(会话开始到本次调用为止) |
| `last_token_usage` | 本次模型调用的**增量** |

两块的字段都是 `input_tokens, cached_input_tokens, output_tokens,
reasoning_output_tokens, total_tokens`。

**一条 `token_count` 对应一次底层模型调用,不是一轮。** 一轮内有多次工具调用就有多条
(实测:40 个 turn 里最少 1 条、最多 88 条、中位数 12)。

`info` 有 **1.79%**(17/948)是 `null`,必须判空跳过。

### 5.3 取增量:对 `total_token_usage` 做差分,**不要**直接用 `last_token_usage`

这是这份设计里最重要的一个决定,它来自实测而不是推理。

**`last_token_usage` 逐条上报会多算接近一倍。** 931 条非空记录里
**47.5%(442 条)与紧邻前一条逐字节相同** —— 同一次真实调用的用量被记了两次。
20 份有数据的文件里 17 份因此多算,倍数集中在 **1.84×~1.99×**。

所以改成差分:

```
第一条记录:  本条增量 = last_token_usage[本条]
其后每一条:  本条增量 = total_token_usage[本条] − 上次见过的 total_token_usage
```

这是恒等式,不是"去掉与前一条相同的记录"那种模式匹配。选它的三个理由:

1. **重复事件的差分天然是 0**,而上报器**本来就丢弃全零事件**(两个现有 host 都有
   这个守卫)。不需要写任何去重代码。
2. **漏读一条时下一条的差分自动补上** —— 累计值天生自愈。
3. **不需要跨进程记住任何东西**:上次的累计值存进契约的 `entry`,那正是 `entry` 的用途。

模式匹配那条路还有个无法回答的问题:"与前一条逐字节相同"到底是重复事件,还是两次
恰好一样的真实调用?差分法不需要回答它。而这个问题实测已有答案(§9.2):那 442 条
重复记录的 `total` **无一例外原地不动**,所以它们确实是重复事件。

**两条防御分支,它们防的是"没采到样"而不是"观测到的问题":**

实测的 20 份会话里**没有一份经历过 `/compact` 压缩或 resume/fork**,而这两种场景恰好
都会让朴素的差分算错钱。所以两处都按"不依赖观测也正确"来写:

1. **第一条记录用 `last_token_usage`,不用 `total − 0`。** 在实测数据里两者相同
   (§9.4:20/20 首条 `total == last`),所以这个选择**零代价**;但如果 resume 的会话
   一开始就带着继承来的累计值,`total − 0` 会把**继承的那一段误报成本次用量**,而用
   `last` 就是对的。
2. **差分为负时:夹到 0、把基准重置为本条的 `total`、记一行日志。** 只夹不重置是错的
   —— 那样基准会永远停在回退前的高位,**之后整段用量全部少报**,而 `--status` 一切正常。
   实测从未出现负差分(§9.1),所以这条分支**必须用合成夹具测**,不可能靠真实数据碰到。

### 5.4 `entry` 的形状

契约允许 `probe`/`read` 带任意 host 自有数据进出 `entry`:

```js
entry = {
  mtimeMs,        // 契约要求
  offset,         // 已读到的字节位置,增量读用
  seen,           // 已数过的 token_count 记录条数 → 合成 requestId 用
  lastTotal: { input, cached, output } | null,       // 差分基准;null = 还没见过
  model,          // 最近一条 turn_context 的模型名
  sessionId,      // session_meta.payload.id
  provider,       // session_meta.payload.model_provider
}
```

**后三个字段必须持久化,这不是可选的。** `session_meta` 和 `turn_context` 在文件**开头**,
而第二次增量读只看新追加的那几行 —— 那里通常一条都没有。不把它们存进 `entry`,
第一次读正常、**之后每次读都会因为拿不到 model/sessionId 而把事件全丢掉**,
而 `--status` 只会显示"没有新用量"。

### 5.5 载荷映射

**这里有一个跨厂商的语义陷阱,原样传就是重复计费。**

`total_tokens = input_tokens + output_tokens` 是恒等式(931/931 命中,其余三种组合
都不是),而 `input_tokens >= cached_input_tokens` 恒成立(931/931,从未出现
`<` 或 `==`)—— 也就是说 **OpenAI 的 `input_tokens` 已经把 cached 算在里面了**。
Anthropic 的不算。

而 portal 载荷里 `inputTokens` 与 `cacheReadTokens` 是**两个分别计价的桶**。所以:

| portal 字段 | 取值 | 为什么 |
|---|---|---|
| `inputTokens` | `Δinput − Δcached` | **必须减。** 不减的话缓存那部分会同时算成"新鲜输入"和"缓存读",计两遍价 |
| `cacheReadTokens` | `Δcached` | |
| `outputTokens` | `Δoutput` | **已含 reasoning**(931/931 `output >= reasoning`),**不能再加一次** |
| `cacheWrite5mTokens` | `0` | OpenAI 的缓存写入不单独计价 |
| `cacheWrite1hTokens` | `0` | 同上 |
| `model` | 最近一条 `turn_context.payload.model` | 每轮快照,支持会话内 `/model` 切换 |
| `ts` | 该记录顶层的 `timestamp`(ISO8601) | **不用"现在"** —— 补扫时会把旧用量标成今天 |
| `requestId` | `codex:<session_id>:<n>` | 见下 |

agy 那个 host 当年就是这么处理的(它注释里写的是 "uncached input varint"),所以这是
这个仓已知的形状,不是本设计发明的。

`reasoning_output_tokens` **不单独上报** —— portal 没有这个桶,而 OpenAI 按输出计价,
它已经在 `outputTokens` 里了。记在这里是为了防止后来的人"补上遗漏的字段"。

### 5.6 去重键

**Codex 的记录里没有 request id。** 所以合成:

```
codex:<session_id>:<n>
```

`n` 是该记录在文件中**所有 `token_count` 记录里的序号**(从 0 起),**不是**已上报
事件的序号 —— 差分为 0 的记录不产生事件,但仍然占一个序号,否则重读时序号会错位。

文件是 append-only,所以序号稳定。portal 侧按 `requestId` 去重
(`keyOf = (e) => e.requestId || e.messageId`),所以重复上报是幂等的。

## 6. 走 llm-web 网关的会话必须跳过 —— 但这是**每会话**的判断

Claude Code 那个 host 有一条:`ANTHROPIC_BASE_URL` 指向 portal 时**不报**,因为请求
经过 `/v1` 代理时已经计过一次。Codex 有同构的情形(llm-web 本来就服务 OpenAI 线格式)。

**但它不能放在 `skipReason` 里。** 契约里 `skipReason(config)` 只拿得到 reporter 自己的
配置,是个**全局**开关;而 Codex 走没走网关是**每个会话**的属性 —— 同一台机器上一个会话
走网关、下一个走 ChatGPT 登录,完全正常。所以这个过滤放进 `read()`,按文件判断。

**信号(实测):`session_meta.payload.model_provider`** —— 每份 rollout 文件第一行里
的一个 **provider id 字符串**(本机真实值 `"openai"`),不是 URL。

- `turn_context` 里**没有** provider / base_url(核过 0.154.0 的 schema 与本机 5 份
  真实历史文件,键表里都没有),所以只能从 `session_meta` 取,一份文件读一次。
- **`skipReason` 仍然返回 `null`**,像 agy 那样,并在注释里写明原因是"这件事按会话判断,
  见 `read()`",免得后来的人以为是漏了。

匹配哪个 id:llm-web 的 `/setup` 页生成器(`llm-web/src/client/lib/agentConfig.ts`,
`PROVIDER_ID = "jianyuelab"`)固定写 `model_provider = "jianyuelab"`,所以匹配这个字面量。

**已知局限,如实写进 README:** 用户手改 provider id(没用官方生成器)就会漏判,导致
同一批 token 记两遍。rollout 数据里**没有更强的信号** —— base_url 只在 `config.toml` 里,
而那个文件在会话之后可能已被改过,拿它回溯判断反而更不可靠。

**没有环境变量能覆盖 base_url。** 查过:Codex 只有 `CODEX_AUTHAPI_BASE_URL` 等内部端点,
**没有** `ANTHROPIC_BASE_URL` 那种能覆盖 `model_providers.<id>.base_url` 的变量
(CLI 的 `-c model_providers.<id>.base_url=…` 是唯一覆盖途径)。所以不要去找环境变量。

## 7. 失败模式

| 情形 | 行为 |
|---|---|
| 没配 hook | 什么都不发生;`--status` 显示 ready 但没有活动 |
| hook 触发了但文件 glob 不到 | 记一行日志,exit 0 |
| `info` 为 `null` | 跳过该记录,不记日志(1.79% 是常态,不是异常) |
| 差分为 0 | 不产生事件(这就是重复事件的处置) |
| 差分为**负** | 夹到 0,**并把基准重置为本条的 `total`**,记一行日志。实测从未出现(§9.1),但 `/compact` 与 resume 两种场景未采样 |
| 文件首条记录 | 用 `last_token_usage` 当增量,不用 `total − 0`(§5.3 防御分支 1) |
| 文件被删 | `probe` 返回 `null`,状态条目被清掉 |
| 上传失败 | 进 spool,下次重试(现成机制) |
| Codex 跑 `--ephemeral` | **不落盘 session 文件,这条路上的用量无法上报。** 已知缺口,见 §9.8 |

**继承的不变量,一条不松:**

- **永不非零退出、永不向 hook 抛异常。** hook 挂掉不该让 Codex 显示错误。
- **无密钥、无网络时全部测试必须绿。**
- **零依赖、零构建。**
- 密钥只从 env / `~/.claude/jyl-usage/config.json` 读,**绝不打印、记录、写进 URL**。

## 8. 安装面与测试

### 8.1 安装:一个独立的 Codex 插件目录

**0.154.0 里没有 `[hooks]` 这个 TOML 表。** hooks 是一个独立的 **`hooks.json`**,
按 **`<plugin_root>/hooks.json`** 这个固定文件名自动发现(实测:本机两个真实插件
`replayio` 与 `figma` 都是如此,且它们的 `.codex-plugin/plugin.json` 里并没有写
`"hooks"` 指针)。

**格式与根目录那份撞车,所以必须另起一个目录:**

| | 形状 |
|---|---|
| agy(根 `hooks.json`) | `{"jyl-usage": {"Stop": [{type, command, timeout}]}}` |
| Claude Code(`hooks/hooks.json`) | `{"hooks": {"Stop": [{matcher, hooks: [...]}]}}` |
| **Codex**(实测) | `{"hooks": {"Stop": [{hooks: [...]}]}}` —— 与 Claude Code 同形 |

Codex 若以仓库根为插件根,会读到 agy 那份、找不到 `"hooks"` 键。所以新增
**`codex-plugin/`**:`.codex-plugin/plugin.json` + `hooks.json`。这与仓里既有的
"每个 host 的清单放在互不冲突的位置"的做法一致。

`hooks.json` 内容(照实测形状):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "<绝对路径>/scripts/run --host codex --detach" } ] }
    ]
  }
}
```

**命令用绝对路径,不用相对路径或插件根变量。** 插件根是 `codex-plugin/` 而 `scripts/run`
在它的上一级;Codex 有没有 `${CODEX_PLUGIN_ROOT}` 这类变量未经证实。绝对路径没有未知数,
README 让用户替换自己的 checkout 路径即可 —— 与 harness 那个 `[[hooks]]` 块的做法一致。

**`Stop` 默认是阻塞的**(实测:`HookHandlerConfig::Command` 的 `async` 字段默认 `false`;
二进制里还有 `"Stop hook exited with code 2 but did not write a continuation prompt to
stderr"` 这样的文案,说明同步 hook 的退出码 2 会让 Codex 等着读续跑提示)。所以
`--detach` 是必需的而不是保险。`hooks.json` 里还可以再加 `"async": true` 做双保险 ——
该字段存在(实测),但本机没有真实样例用到它,行为未验。

**插件怎么安装到 Codex 里,是 §9.5 的待定项** —— 本机看到的插件躺在
`~/.codex/.tmp/plugins/plugins/<name>/`,那个 `.tmp` 路径像是内部暂存区,不是用户该手写的
位置。落地前要确认正确的安装途径(多半有 `codex plugin` 一类子命令)。

### 8.2 测试

照 `tests/antigravity-host.test.js` 的形状:

- **不碰真实 home。** `fs.mkdtempSync`,`afterAll` 清掉。
- **导出可变的 `roots`**(agy 那样),让测试把 sessions 目录重定向到临时目录 ——
  **不要**像 Claude Code 那样写死路径常量,那会让 `recentUnits`/`stateDir` 永远
  测不到。
- **不联网。** host 适配器测试只直接测 `read`/`probe`/`skipReason`/`describePending`,
  不经过 `upload`/`report`,所以连 fetch 打桩都不需要。
- **夹具用代码造,不提交真实会话文件。** Codex 的记录里有对话内容,**不许**把真实
  rollout 文件当夹具提交 —— 写一个小 helper 生成合成的 JSONL。
- 每条断言配一次变异:去生产代码里改坏它(仍要能跑),跑**整套** `bun test`,
  确认红的是那一条。这个仓反复出现"测试绿但守的不是它名字说的那件事",
  只有变异抓得住。

**必须有的几条断言**(都对应上面某个会算错钱的地方):

1. 连续两条逐字节相同的 `token_count` → **只产生一个事件**
2. `inputTokens` 是**减掉 cached 之后**的数 —— 断言具体数字,不是"大于 0"
3. `outputTokens` **没有**把 reasoning 再加一遍
4. `info: null` 的记录被跳过且不影响后续序号
5. 序号按 `token_count` 记录位置走,差分为 0 的记录**仍然占位**
6. 模型名取的是**最近一条** `turn_context`,而不是文件里第一条
7. `skipReason` 在配成走 llm-web 网关时返回非 null
8. **首条记录用 `last` 而不是 `total`** —— 夹具造一份"首条 `total` 大于 `last`"的
   会话(模拟 resume 继承),断言上报的是 `last` 而不是整个继承累计值
9. **负差分会重置基准** —— 夹具造一次回退,断言该条夹到 0、**且下一条不会少报**
   (只夹不重置的实现会在这一条上红)

## 9. 待验事实 / 待定项

**§9.1–§9.4 已验完**,数据来自本机 30 份真实会话 / 948 条 `token_count` 记录
(其中 931 条 `info` 非空)。差分法(§5.3)成立。

**§9.1 `total_token_usage` 单调不减 —— 成立。** 出现下降的文件 **0/20**,下降事件 0 次。

**§9.2 重复记录的 `total` 也相同 —— 成立。** 442 条里 `total` 相同 **442**、前进 **0**、
后退 **0**。所以它们是重复事件,不是"恰好用量相同的两次真实调用"。

**§9.3 差分求和 = 末条 `total` —— 成立,20/20 精确。** 所以实现里**不需要"去重"这一步**
(差分求和是 telescoping 恒等式)。

**§9.4 首条 `total == last` —— 成立,20/20。**

**§9.4a 上面四条的样本局限,以及为什么设计仍要带防御分支。**
这 20 份文件里**没有一份经历过 `/compact` 压缩或 resume/fork**。所以 §9.1 与 §9.4
准确的说法是"在这批数据里没发生过",不是"在那两种场景下验证过"。两个未采样场景恰好
都会让朴素差分算错钱,所以 §5.3 带了两条防御分支;它们在实测数据上零代价,在未采样
场景下才起作用。**这两条只能用合成夹具测**(§8.2 第 8、9 条)—— 真实数据永远碰不到。

**§9.5 插件怎么装进 Codex。** 格式与发现路径已实测(§8.1),但**安装途径未定**:
本机的插件在 `~/.codex/.tmp/plugins/plugins/<name>/`,那个 `.tmp` 像内部暂存区。
要确认是否有 `codex plugin` 子命令,或者用户级 `~/.codex/hooks.json` 是否可用
(`HookSource` 枚举里确实有 `user` 取值,但本机没有这个文件,路径未实测)。
项目级 `.codex/hooks/` 是推断,也未实测。**这条要在实现的验证任务里用一个一次性目录
试出来,不能猜。**

**§9.6 `Stop` 是否阻塞 —— 已答:默认阻塞。** 见 §8.1。`--detach` 因此是必需的。

**§9.7 网关检测 —— 已答,且结论改变了结构。** 信号是每会话的
`session_meta.payload.model_provider`,所以过滤放进 `read()` 而不是 `skipReason`。见 §6。

**§9.8 `--ephemeral` 模式的用量无法上报。** 有意接受:那个模式刻意不落盘,而这条路
靠读落盘文件。不去追(要追就得走 `codex exec --json` 的 wrapper 路线,那是另一个
形状)。README 要写明。

**§9.9 `codex exec --json` 这条路被搁置。** 它可能是脚本化场景更直接的挂点
(逐行读 stdout),但**输出形状未经实测**,而且它服务的是另一个使用方式。
不在这一版里。
