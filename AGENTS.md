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
