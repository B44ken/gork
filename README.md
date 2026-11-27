# gork

a discord bot that is one long-running claude agent with a bash shell. old bot: `legacy` branch.

discord events get fed into a single agent session. its only tool is `bash`, a virtual
[just-bash](https://github.com/vercel-labs/just-bash) shell, so it does everything through files and commands:

```
/AGENTS.md /SOUL.md   how it works, who it is
/memory/              notes, one file per user and channel
/bin/                 its own scripts (reply.sh, react.sh, ...)
/chat/                discord as lazy read-only files: channel/<id>.md, attachments
/src/                 this repo
```

`discord <METHOD> <route> [json]` hits the whole REST API. it changes itself by editing `/src` and
running `deploy`, which typechecks, tests, commits and hot-reloads. only `src/kernel.ts` needs a restart.

## running

```bash
bun install
bun start
```

needs `claude login` and an `instances.json`:

```json
{ "instances": [{ "name": "clod", "directory": "/path/to/instance" }] }
```

the instance dir holds `.env.local` (`DISCORD_TOKEN`, optional `EXA_API_KEY`) and gets a `workspace/`
from `template/` on first run. trace of what it's doing: http://localhost:6769
