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
