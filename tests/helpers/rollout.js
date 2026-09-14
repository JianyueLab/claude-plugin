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
