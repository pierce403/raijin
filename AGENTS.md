# AGENTS.md - Instructions for Coding Agents

## Self-Improvement Directive

Read this file at the start of every task and update it before finishing whenever you learn something that will help future agents.

Capture:

- verified build, test, and deploy commands
- codebase conventions and routing assumptions
- bugs, regressions, and fixes that were discovered
- operator preferences and workflow expectations
- concrete pitfalls to avoid next time

Keep updates specific. Prefer exact commands, file paths, and failure modes over generic advice.

## Collaborator Preferences

- Keep the implementation small and boring.
- Favor end-to-end working paths over abstractions.
- This repo should be committed and pushed after every completed task unless the user explicitly says not to.
- Stage only files relevant to the task. Do not silently include unrelated work.
- On the landing page, do not surface OpenGraph metadata as a separate preview card unless explicitly requested.
- Avoid heavy em dash usage in UI copy and metadata; prefer plain punctuation/hyphenated phrasing.

## Project Overview

`raijin.sh` is an ephemeral browser-to-terminal bridge for systems the operator controls.

Current architecture:

- Cloudflare Worker serves static assets and request routing.
- Durable Object holds only in-memory live session relay state.
- Browser owns session metadata and stores it in `localStorage`.
- Browser generates `sessionId`, `browserToken`, and `agentToken`.
- Remote side is a Python 3 stdlib-only bootstrap fetched from `GET /bootstrap?c=...`.

## Important Files

- `src/index.js`: Worker routes and Python bootstrap generation.
- `src/session-do.js`: in-memory session relay and auth checks.
- `src/frontend/home.js`: creates browser-owned sessions.
- `src/frontend/session.js`: session page, websocket client, terminal UI.
- `src/frontend/session-store.js`: localStorage helpers and bootstrap config encoding.
- `wrangler.jsonc`: Worker config, assets, Durable Object binding, worker-first routes.

## Verified Commands

```bash
npm install
npm run build
npx wrangler dev --local --port 8787
npx wrangler deploy --dry-run
```

## Coding Conventions

- Keep the frontend static-first and dependency-light.
- Use vanilla HTML/CSS/JS plus `xterm.js`; do not introduce framework complexity without a strong reason.
- Preserve the black/orange terminal aesthetic.
- Keep the server boring: relay traffic, enforce session rules, avoid persistence.
- Prefer explicit status transitions: `waiting_for_browser`, `waiting_for_agent`, `connected`, `expired`, `disconnected`, `ended`, `agent_closed`.

## Known Issues And Solutions

- Browser-owned session metadata is origin-scoped because it lives in `localStorage`.
  Fix:
  Pass the newly created session bundle in the URL fragment during navigation, then rehydrate and resave it on the final origin in `src/frontend/session.js`.

- xterm clipboard shortcuts need explicit browser-side handling in `src/frontend/session.js`.
  Fix:
  Treat `Cmd/Ctrl+C` as copy only when `terminal.hasSelection()` is true so interactive `Ctrl+C` still reaches the remote shell, and explicitly handle keyboard paste shortcuts like `Cmd/Ctrl+V`, `Ctrl+Shift+V`, and `Shift+Insert` because xterm key handling can consume them before the browser paste flow runs.

- Async keyboard paste on the deployed site needs `clipboard-read` in the page `Permissions-Policy`.
  Fix:
  `src/index.js` should send `clipboard-read=(self), clipboard-write=(self)` so `navigator.clipboard.readText()` works for terminal paste shortcuts on the session page.

- Do not refocus xterm on `pointerdown` in `src/frontend/session.js`.
  Fix:
  xterm already focuses itself on terminal `mousedown`. An extra pointerdown refocus can interrupt drag selection and make text highlighting look broken. Keep focus restoration on connect/window focus only.

- Do not rely on xterm screen-reader mode as a text-selection workaround.
  Fix:
  The attempted `Select Text` mode was not reliable enough in practice. Prefer transcript export instead: `session.html`, `src/frontend/session.js`, and `src/frontend/home.js` now expose `Download Transcript` actions backed by local tx/rx logs.

- The connected cursor is easy to lose if the terminal briefly drops focus.
  Fix:
  Keep the xterm cursor visible with `cursorStyle: "block"` and `cursorInactiveStyle: "outline"`, and refocus the terminal on connect/window focus rather than adding more UI chrome.

- Landing page session history now lives in the separate localStorage key `raijin:session-history`.
  Fix:
  Keep archived entries lightweight in `src/frontend/session-store.js` and preserve only searchable fields like `sessionId`, `mode`, `lastStatus`, `remoteIp`, and timestamps. Do not depend on live `raijin:session:*` records for old-session history because `deleteSession()` removes those active metadata blobs.

- Session transcript search now comes from separate localStorage records at `raijin:session-log:<sessionId>`.
  Fix:
  Append tx/rx text from `src/frontend/session.js` on a short debounce instead of writing to localStorage on every packet, and cap each direction to the most recent 65536 characters in `src/frontend/session-store.js` so transcript search and transcript download stay useful without exhausting browser storage.

- Only show "Open Session" on the landing-page history list when `hasLocalSession` is true.
  Fix:
  Archived history entries do not have the per-session browser metadata needed by `src/frontend/session.js`, so linking archived rows straight to `/s/:id` will only produce "Session metadata was not found for this origin."

- A global hourly server-side sweeper would require a persisted registry of session IDs.
  Fix:
  Prefer per-session expiry timers plus `clearRuntimeState()` in `src/session-do.js` so ended sessions drop browser/agent tokens and other runtime metadata without introducing a new persisted server-side session index.

- `/bootstrap?c=...` must be included in `assets.run_worker_first` in `wrangler.jsonc`.
  If only `/bootstrap/*` is listed, the asset handler will intercept the request and return a 404.

- `wrangler dev` may still show unrelated local environment variables from `.dev.vars`.
  The current app does not require `SESSION_SIGNING_KEY`; ignore that leftover local env unless the config is later cleaned up locally.

- To disable the hard max lifetime, set `maxLifetimeSeconds: null` in browser session metadata.
  `src/session-do.js` treats missing/non-positive `maxLifetimeSeconds` as unlimited while still enforcing idle timeout expiry.

## Remote Bootstrap Notes

- The bootstrap uses Python 3 stdlib only.
- Default interactive shell is `/bin/sh -li`.
- Forced command mode uses `/bin/sh -lc <command>`.
- Readonly mode ignores browser `stdin` but still streams terminal output.
- Agent transport is HTTP long-poll plus POST, not WebSocket.

## Deployment Notes

- GitHub remote is `git@github.com:pierce403/raijin.git`.
- `main` is the active branch and currently tracks `origin/main`.
- For this repository, pushing directly to `main` is currently the established path.

## Agent Workflow

1. Read this file first.
2. Inspect the relevant code paths before editing.
3. Run the smallest verification that proves the task works.
4. Update this file if you learned something durable.
5. Commit with a focused message.
6. Push the result to `origin`.
