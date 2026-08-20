---
description: Inspect or drive the JianyueLab usage reporter (status, flush, backfill)
argument-hint: "[status | flush | backfill [days]]"
---

Run the JianyueLab usage reporter's CLI and report what it says.

The subcommand the user asked for is `$ARGUMENTS` (empty means `status`). Map it
to exactly one `Bash` call — the script lives at `${CLAUDE_PLUGIN_ROOT}/scripts/run`:

| Argument            | Command                                              | What it does |
|---------------------|------------------------------------------------------|--------------|
| _(empty)_ / `status`| `"${CLAUDE_PLUGIN_ROOT}/scripts/run" --status`        | Where it reports to, whether it is configured, how many events are waiting to retry, recent log lines. Reads only. |
| `flush`             | `"${CLAUDE_PLUGIN_ROOT}/scripts/run" --flush`         | Retry events queued by earlier failed uploads. |
| `backfill [days]`   | `"${CLAUDE_PLUGIN_ROOT}/scripts/run" --backfill [days]` | Scan **every** transcript touched in the last N days (default 30) and report anything not sent yet. Safe to repeat: the portal deduplicates on request id. |

Then summarise the output in a sentence or two. If the status says it is not
reporting, say why and point at the fix:

- **no base URL / no API key** — the reporter needs both. Either export
  `JYL_USAGE_BASE_URL` (the portal origin, *not* its `/v1` base) and `JYL_API_KEY`
  in the shell, or write `~/.claude/jyl-usage/config.json`:

  ```json
  { "baseUrl": "https://llm.jianyuelab.co", "apiKey": "jyl-…" }
  ```

  Portal keys come from the portal's **API keys** page.

- **disabled** — `"enabled": false` in that config file, or `JYL_USAGE_DISABLED=1`
  in the environment.

- **the note about `ANTHROPIC_BASE_URL`** — this session already talks to the
  portal, so its `/v1` proxy metered these turns on the way past and reporting
  them again would count the same tokens twice. Nothing to fix.

Do not edit the config file unless the user asks you to; it holds a secret.
