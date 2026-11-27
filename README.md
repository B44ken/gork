# μ(t) local instance

This checkout runs the μ(t) Discord bot through the Codex app-server using the existing ChatGPT sign-in (`codex login`). Set `CODEX_BIN` in `.env.local` to the Codex executable. Chat, source investigation, and monkeypatch use Codex; image requests use Codex's image tool with `backend=codex` and the OpenAI Images API with `backend=api`, honoring the `image.model`, `image.size`, and `image.quality` settings. The `/gork config backend` setting picks `codex` (ChatGPT sign-in) or `api` (`OPENAI_API_KEY` from the instance `.env.local`). Codex keeps the two logins apart: `api` runs with `CODEX_HOME` set to `CODEX_HOME_API` (default `~/.codex-api`), so seed that home once with `printenv OPENAI_API_KEY | CODEX_HOME=~/.codex-api codex login --with-api-key`; monkeypatch stays on the `codex` backend because its Codex SDK needs the ChatGPT sign-in. Exa searches still use `EXA_API_KEY`. One `bun run bot` process hosts every configured instance; each instance keeps its own `.env.local`, `db.json`, `persona.json`, `reply-limits.json`, `blacklist.sqlite`, and `usage.sqlite` in its own data directory, so Clod’s memories and persona are not copied between them. Automatic replies are disabled; mention μ(t) to get a reply. Replies default to 140 characters, with owner-managed per-channel overrides stored in `reply-limits.json`. Use `/gork channel-limit view`, `/gork channel-limit set channel_id:<id> limit:<length>`, and `/gork channel-limit reset channel_id:<id>`; the owner can also manage limits through the channel-limit tools. Replies and `send_message` output are capped using the destination channel’s limit.

Run manually with `bun run bot`. The background service is `ca.brad.gork`; logs are in `~/Library/Logs/gork.out.log` and `~/Library/Logs/gork.err.log`. Run `bun test` and `bun run typecheck` to validate the code.

## Instances

`instances.json` (gitignored, next to this README) lists the instances started by the single process. Without it, the process runs one instance from the current directory using `DISCORD_TOKEN` and `GORK_PORT`. Each entry takes:

- `name`: label used in startup errors.
- `directory`: the instance data directory holding `db.json`, `persona.json`, `blacklist.sqlite`, `usage.sqlite`, and `.env.local`. Relative paths resolve against the manifest.
- `envFile`: optional, defaults to `.env.local` inside `directory`.
- `token` / `exaApiKey`: optional overrides; prefer `.env.local`.

With more than one instance, every instance must supply its own token through `directory`/`envFile` or `token`, because falling back to one shared `DISCORD_TOKEN` would log the same bot in twice. Instance names and directories must be unique. A failing instance is logged and skipped; the rest keep running.

# clod persona

persona commands and tools are available to everyone who can use clod. monkeypatch is available only to b4444, through both its command and model tool.

clod responds to explicit user mentions in message text even when Discord pings are disabled, including mentions from other bots. it continues to ignore its own messages.

monkeypatch accepts `medium` or `high` effort; it defaults to `high`. use `/monkeypatch task:<task> effort:<level>`, or ask clod to make the change in an owner message.

attach text or source-code files to a message to let clod read them, or reply to a message containing them. clod also reads images attached to those messages.

ask clod to create an image, or attach an image or reply to one and ask for an edit. Image requests use Codex’s native image-generation tool with the ChatGPT sign-in. The resulting PNG is attached to clod's reply. Edits use the images attached to the current message and its direct reply. Image requests are tracked separately in usage.sqlite; their cost is currently unpriced.

the public `view-image` tool sends an image at a url to the model. it supports png, jpeg, webp, and gif; permits only public ipv4 http/https addresses on standard ports; checks every redirect; and limits download size and time. compressed responses are not supported. failures are logged without the url.

everyone can use `/agent task:<question>` or ask clod to spawn a coding agent to investigate its code. the agent can list and read clod's source, but cannot run commands, edit files, or use clod's other tools. only the owner can use monkeypatch for changes.

use `/persona view`, `/persona set prompt:<text>`, or `/persona reset`. the assistant can also view, set, and reset the persona with tools. the prompt must contain 1–1800 characters. changes are saved in `persona.json` and apply to subsequent requests. `{limit}` is replaced with the current channel limit and `{facts}` with the facts remembered about the users in the conversation; Clod also appends the channel limit instruction to the system prompt. viewing the persona does not include channel instructions or memories.

memories are keyed by discord user id. `/memories` commands select a discord user, and model tools use the ids in the conversation. memory labels resolve current usernames and server display names. `/gork config` has typed subcommands for each setting.

Only the Discord application's owner can use `discord-repl` to run JavaScript against the live discord.js client. The tool is omitted for other callers, and execution checks the caller again. Bot and webhook messages cannot use it. Code runs with the bot process's permissions, including file and credential access; this is not a sandbox.

Only the application owner can use `/blacklist add user:`, `/blacklist remove user:`, and `/blacklist list`. All confirmations, lists, and permission denials are ephemeral. The command is disabled for non-admins by default in Discord, with application-owner authorization enforced by the bot. The blacklist persists in private, ignored `blacklist.sqlite`, separate from memories and the dashboard. When a blacklisted user triggers a bot reply, it reports that the user was added by the owner without calling the model or downloading attachments. Other slash commands are also blocked for that user; owner-only blacklist management remains available for recovery.

Clod also classifies request text for targeted slur abuse, targeted sexual solicitation or harassment, threats to drug someone without consent, terrorist assistance, and harmful weapon assistance, while allowing ordinary date invitations and benign discussion, reporting, and counterspeech. Recent channel messages provide context for the current request, including rejection and repeated targeting; only the current sender is evaluated. It applies a configurable bot timeout (two minutes by default) and reports the category and remaining time on later requests. Existing timeouts created before reasons were stored report that the reason is unavailable. These timeouts persist across restarts, are separate from permanent blacklist entries, and can be cleared with `/blacklist remove`. Classification is model-based and can make mistakes; attachments are not classified.

any human user can ask clod to send a message or upload one image to the current channel, another channel in the same server, or the current DM. the requester and clod must both be able to view and send in the target (including private-thread membership); image uploads also require both to have Attach Files. since bots bypass Discord slowmode, clod refuses sends to slowmode channels unless the requester can bypass slowmode. mentions do not notify anyone. clod sends at most once per request and allows up to 3 send attempts per user, 5 per destination channel, and 20 globally per minute. limits are in memory and reset on restart. bot and webhook messages cannot use these tools.

image uploads accept only public HTTP(S) URLs, not local files, and validate every redirect and resolved address. downloads are limited to 4 MiB and 15 seconds, and their bytes must identify as PNG, JPEG, WebP, or GIF. clod checks message text, URLs, and image bytes for known runtime secrets, but cannot identify every possible secret. the model chooses the content and destination and can be influenced by conversation and the public persona.

the public `find-messages` tool reads up to the last 200 messages of the current channel or another channel in the server and filters them by text and author, or returns one message id. `react` adds a single emoji reaction to the message being replied to, the current message, or a message id. both require the requester and the bot to have View Channel, plus Read Message History for searches and Add Reactions for reactions, and are rate limited in memory. a reply target is also shown in the transcript with its message id, so clod can act on it without searching. a reply to one of clod's messages reaches clod the same way an `@` does; a conversation thread is capped at six consecutive bot messages, so bot ping-pong stops after six bot replies while any human message ends the run and is always answered; message search and reactions go through these tools; clod does not have general code execution outside the owner-only `discord-repl`.

the public `discord-info` tool offers channel details and member-avatar lookups within the current server, or details of the current DM and its sender. channel access is checked for both requester and bot, including private-thread membership. lookups are limited to 10 per user and 50 globally per minute. these are structured operations, not arbitrary Discord.js or code execution.

results redact sensitive property names, environment values of at least 8 characters, shorter values from sensitive environment variables, and the client token; output is capped at 6000 characters. redaction is best effort: transformed, partial or unknown secrets can escape it. arbitrary code can also transmit secrets through side effects, so this is not a sandbox or a confidentiality boundary. synchronous execution has a 1-second timeout and the response waits up to 5 seconds for async work; async work is not cancelled, and later callbacks or serialization can still block or affect clod.

## Usage tracking

Clod creates `usage.sqlite` on its first tracked request. Chat, investigation, monkeypatch, and image generation record Codex subscription turns, including their source, requested model, thread, status, token totals, cache reads and writes, and reasoning tokens. Codex does not report the models used for individual internal calls, so these turns have no API cost estimate. Exa searches record provider-reported costs separately.

Rows are inserted before dispatch and completed afterward. Failed calls retain their failure status, and interrupted calls remain `in_progress`. Prompts, responses, search queries, tool arguments, credentials, and error messages are not stored. The `initiator` identifies the triggering Discord message and user; slash commands and historical rows can have no initiator.

The public `inspect-usage` tool and dashboard provide read-only aggregates by total, UTC day, source, provider, model, requested model, or initiator, with UTC date bounds or a rolling minute window. Results are limited to 100 groups. Historical API rows and their recorded costs remain queryable, but the retired API transport and price-estimation code have been removed. Known cost uses recorded provider cost first, otherwise a historical estimate; it remains a partial total when rows have no cost.

## Dashboard

The bot serves one passwordless dashboard for every instance on `0.0.0.0:6767` (`GORK_PORT` overrides the port), available at `http://localhost:6767/` and through this Mac’s network address. The root page lists the instances; each one is mounted at `http://localhost:6767/<name>/` and keeps its own state, settings, and usage. No login or password file is used. Changes require same-origin JSON requests with the dashboard’s CSRF token.

The dashboard edits the persona and all ten `/gork config` settings., memories, and the owner-managed blacklist; it also displays usage aggregates. The Moderation section controls automatic moderation, its policy, and the duration of new timeouts. Active timeouts show their reason and expiry and can be cleared without removing a permanent blacklist entry. Settings persist and apply immediately; disabling automatic moderation does not erase existing timeouts or permanent bans. Changes use the bot's existing functions and apply to subsequent requests. The blacklist remove action also clears a temporary timeout. The dashboard does not provide the Discord-context tools (messaging, Discord lookups, image operations), source and coding agents, monkeypatch or the Discord REPL. Their existing Discord permissions remain in force.

The dashboard retains its original network access. Browser writes require the dashboard’s origin and CSRF token.

Configuration is defined in `bot/config.ts`: shared model, backend, and image choices, setting metadata, validation, and persistence for both slash commands and the dashboard. Runtime values remain in `db.json`; `bot/state.ts` handles JSON updates so memory edits preserve settings and settings edits preserve memories. Dashboard state and username presentation live in `site/state.ts`, separate from the HTTP routes.

## Message archive

`bun run archive --days 84` pulls guild history with the bot's own token into `exports/<guild>-<date>.jsonl` (gitignored), plus a `.summary.json`. It pages every text channel and active thread in the window and lists archived public threads per parent. Channels the bot cannot see are logged and skipped rather than failing the run.

`bun run archive-ui` serves a browser for those files on `http://127.0.0.1:6768` (override with `--port`/`--host`/`--file`). `scripts/conversations.ts` turns raw messages into conversations: messages are grouped per channel and split after `gap` minutes of silence, consecutive messages merge into one turn, and the first two distinct speakers alternate `user`/`assistant` so every transcript starts with `user` and ends with `assistant`. Discord mentions and custom emoji are rewritten to plain text.

The UI filters by text, date range, channel, author, minimum turns or people, character bounds, attachments, and whether bot messages are kept, then previews each transcript and exports the matching set. `chatml` writes `{"messages": [...]}` rows and `sharegpt` writes `{"conversations": [...]}` rows, both ready for `load_dataset("json", ...)` and Unsloth/TRL (`standardize_sharegpt` for the sharegpt variant). Downloads stream from `/api/export`; saving writes `exports/datasets/<name>-<timestamp>.jsonl` with a `.meta.json` recording the filters used. The server binds to loopback only and requires a same-origin JSON request for saves.
