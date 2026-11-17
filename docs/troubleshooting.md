# Troubleshooting

## The provider is unreachable

Check the selected profile and endpoint:

```bash
atom-lite --help
atom-lite --provider NAME --model MODEL "say hello"
```

For local servers, confirm `baseUrl` and that the model is loaded. Ollama uses `http://127.0.0.1:11434`; OpenAI-compatible servers usually expose a `/v1` path. See [Providers](./providers.md).

## Unknown model or empty model list

Set `contextWindow` for local models without metadata, and verify the model id:

```jsonc title="~/.config/atom-lite/config.json"
{
  "providers": {
    "ollama": {
      "type": "ollama",
      "model": "qwen2.5-coder:7b",
      "contextWindow": 131072,
    },
  },
}
```

Live model lists are fetched in the background. `/model` includes providers whose key is present in the environment.

## A session is locked

Another process owns the session. The refusal names the holder. Close that terminal or tab, or resume a different session with `/sessions`. A lock left by a killed process is reclaimed automatically.

## A file edit is refused

`FILE_CHANGED_SINCE_READ` means the file changed after the agent read it. Ask the agent to re-read the file, then retry. Do not disable hash guards.

## A tool needs approval

In the terminal, press `y`, `n`, or `t`, or use arrows and Enter; Escape denies. In the browser, use the dialog buttons. If the tab dropped, reconnect; an unanswered approval is denied after the grace period. Non-interactive runs always deny. See [Safety](./safety.md).

## The agent stops while a goal is paused

`/goal pause` freezes new iterations after in-flight work finishes. Run `/goal resume` to continue, or `/goal clear` to remove the goal and the gate. See [Goals](./goals.md).

## The transcript looks empty

The goal panel and transcript share the terminal width. `ctrl+j` hides the panel. If a long answer is off-screen, `ctrl+b` jumps to the bottom. `/thinking` toggles the thinking block.

Some terminals send the same byte sequence for `ctrl+j` and Enter. If `ctrl+j` submits the prompt instead of toggling the sidebar, set `keybindings.toggleGoalPanel` to another key in user config.

## Colours look wrong

`NO_COLOR` and `--no-color` force the no-colour theme. `/theme auto` follows the terminal colour-scheme report, then `COLORFGBG`. See [Config](./config.md#ui).

## Config fails to load

Malformed JSON reports `Invalid JSON in config file: <path>`. Unknown keys are rejected by the strict schema, and validation errors name the offending path. Project config cannot set `mode`, token budgets, `agent`, `ui`, `mcpServers`, or `extensions`. See [Config](./config.md#precedence).

## Tests or typecheck fail after a docs change

```bash
npm run typecheck
npm test
npm run docs:check
```

`docs:check` verifies internal links, config fields, and that private ADRs are not referenced from published docs.
