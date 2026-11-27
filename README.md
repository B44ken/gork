# gork

A Discord bot that is one long-running Claude agent with a workspace. Each instance has a single agent
session (Claude Agent SDK). Discord events are fed into it, and its only tool is `bash`: a virtual
[just-bash](https://github.com/vercel-labs/just-bash) shell. It talks to Discord, remembers things and
edits its own code through files and commands. Its plain-text output goes nowhere.

The previous bot (Codex, per-mention threads, ~25 tools) is on the `legacy` branch.

## What the agent sees

```
/AGENTS.md /SOUL.md     how it works, who it is (its own to edit)
/memory/                MEMORY.md, user/<id>.md, channel/<id>.md
/bin/                   its scripts on PATH: reply.sh, react.sh, ...
/chat/                  Discord, read-only and lazy: channels.md, channel/<id>.md, attachment/...
/src/                   this repo
/tmp/                   scratch
```

Commands: `discord <METHOD> <route> [json]` (the whole REST API), `tail`/`head` on channel files (fetch
exactly N messages), `view` (show an image to the model), `search` (Exa), `deploy`.

## Code

- `src/kernel.ts`: the only file that needs a restart. It holds the module loader and `deploy`.
- `src/boot.ts`: reconciles Discord clients, agent threads and the dashboard with `instances.json`.
- `src/thread.ts`: the agent session. `src/shell.ts`: the bash tool.
- `src/fs/chat.ts`, `src/commands/*`, `src/hooks/*`, `src/site/server.ts`.

Everything except `kernel.ts` hot-reloads. `deploy` (or `kill -HUP` on the process) runs `tsc` and
`bun test`, commits, and swaps in the new code. Nothing changes if a check fails.

## Running

`instances.json` (gitignored) lists instances:

```json
{ "instances": [{ "name": "clod", "directory": "/path/to/instance" }] }
```

Each instance directory holds `.env.local` (`DISCORD_TOKEN`, optional `EXA_API_KEY`), an optional
`config.json` (`MODEL`, `EFFORT`), the saved session id, and `workspace/` (copied from `template/` on first
run). The agent uses your `claude login`.

```bash
bun install
bun start
```

The trace dashboard is on http://localhost:6769/ and shows events, thinking summaries, commands and output.
