# gork

a discord bot that is one long-running claude agent with a bash shell.

it reads discord as files (`/chat/channel/<id>.md`), remembers things in `/memory`, talks with
`discord POST ...`, and edits its own code in `/src` then runs `deploy`.

old bot: `legacy` branch.

```bash
bun install
bun start   # needs instances.json + `claude login`
```

trace: http://localhost:6769
