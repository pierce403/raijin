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
- Browser creates reusable listener credentials. Each Python execution generates a fresh session ID and agent token; the browser creates its independent browser token.
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
npm run build && npm run deploy
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

## Relay Failure Regression Checks (2026-09-29)

- `node --test tests/bootstrap.test.mjs` runs six Python regression cases against the generated bootstrap (Python 3 required). Covers transient errors, retry exhaustion, terminal HTTP errors, and retaining output across 409. In the restricted agent sandbox the Node test runner can hang; running outside that sandbox succeeded.
- With `npx wrangler dev --local --port 8787` running, `node tests/relay-smoke.mjs` checks attached/detached browser output, concurrent long-poll, heartbeat, close, and a real Python PTY bootstrap running a fixed printf command. Uses `ws` supplied by the installed Wrangler dependency tree.
- `RAIJIN_TEST_URL=https://raijin.sh node tests/relay-smoke.mjs` targets fresh production test sessions and closes them afterward. This is an explicit live test, not a read-only probe.
- The reported first `/out` crash did not reproduce locally or on production with an initialized session and detached browser. A browser hello initializes server state; a never-initialized session returns 409. Detached output is ACKed and dropped. Closing a browser after the agent connects intentionally ends the session.
- Bootstrap requests now make at most three attempts for transport errors and HTTP 5xx, with 0.5s/1s backoff. 401/403/410 are terminal; 409 retains its waiting contract. Output retries can duplicate text if the server delivered it but its ACK was lost. There is no exactly-once delivery or server persistence.

- Production deployment verified on 2026-09-29: application commit `a991501`, Worker version `c175a3ff-cffb-42fc-803f-fe86949f8d15`. Public `https://raijin.sh/bootstrap` output matched the committed generator exactly; homepage returned 200; all three relay smoke cases passed, including the real Python PTY command.

- Historical incident diagnostics: Cloudflare GraphQL `workersInvocationsAdaptive` and zone `httpRequestsAdaptiveGroups` were accessible with Wrangler OAuth even when Workers observability telemetry returned 403. Query `datetimeMinute`, path/method/`edgeResponseStatus`, and `avg.sampleInterval`; never equate invocation `success` with HTTP 2xx. Live `wrangler tail raijin --format json` emits JSON events without a readiness banner and worked when a probe generated traffic. Keep raw tails private because request headers and bootstrap URLs may contain tokens.

## Reusable Commands (2026-09-29)

- New Session creates a `/l/:id` listener, stored in `raijin:launcher:<id>`. `LAUNCHERS` binds `src/launcher-do.js`; migration `v2` adds its class. `/l/*` must be worker-first and `launcher.html` must be a Vite input.
- Listener ID is SHA-256/base64url of its browser token. Verify that ownership proof even on an empty DO; possession of the copied agent command must not let a remote agent claim the listener after eviction.
- Each Python execution generates its run ID and agent token once, retries the same registration at `/api/launchers/:id/runs`, and waits for `browserConnected: true` from its own session heartbeat before spawning a PTY. A bare heartbeat 200 can describe an initialized but detached browser; it is not sufficient readiness.
- Registration is bounded to 100 runs per ten minutes in memory. Agent startup waits up to five minutes. Legacy commands without `reusable: true` keep their prior behavior.
- Incoming connections automatically open in-app terminal tabs in the listener. Each tab owns a persistent iframe at `/s/:id?embedded=1`; switching only changes visibility. Never detach or recreate iframe nodes when rendering tabs, because that closes their WebSockets and shells.
- Session HTML allows CSP `frame-ancestors 'self'`; home/listener pages retain `'none'`. Parent and child messages must validate origin, source window, session ID, and message type. Activation messages include an `active` boolean so background frames cannot steal terminal focus or send zero-sized resizes.
- Keyboard tab navigation sends `focusTerminal: false`; otherwise the child's async focus steals subsequent arrow keys from the tab strip. Mouse selection and incoming connections focus the active terminal.
- Closing a tab explicitly ends only its session. Closing or reloading the listener closes all its child shells. Mark frames closed in saved run history on pagehide so replay cannot resurrect those sessions. Ended tabs keep their output visible until dismissed.
- Replayed run notifications and listener reloads must preserve child browser credentials and never reopen or resurrect ended sessions. Launcher run history uses a separate `raijin:launcher-runs:<id>` record. Saved listeners appear in Recent Commands.
- A stale/replaced browser socket closing must return early in `SessionDurableObject.handleBrowserClose`; otherwise opening a replacement tab can terminate the current child session.
- Strip session fragments even when localStorage already holds metadata, since listeners save metadata before navigating child frames. Preserve the query string so embedded mode survives fragment removal.
- `node --test tests/bootstrap.test.mjs tests/launcher.test.mjs tests/embedding.test.mjs` checks bootstrap retries, terminal tab lifecycle/replay, and frame policy. `node tests/reusable-smoke.mjs` against local Wrangler checks real concurrent PTYs, isolated I/O/auth, re-use after exit, readiness, and stale-socket closure. `tests/relay-smoke.mjs` checks legacy behavior. Public smoke uses `RAIJIN_TEST_URL=https://raijin.sh`.

- Buffer the bounded registration body in the Worker before forwarding to the listener DO. Forwarding the live request stream triggered local workerd `Can't read from request stream after response has been sent` on early 409/403 responses. The registration body limit is 1024 bytes.
- Reusable commands deployed from application commit `8681403` as Worker version `1a5a1413-be0f-4701-9365-4cdcdc5473a6`. Production reusable and legacy smoke suites passed; public bootstrap/home/listener responses matched the local build exactly. Real-browser local testing confirmed blocked-popup recovery into two independent terminals, and the production listener reached `listening`.
- Automatic in-app tabs deployed from `a5c87fd` as Worker version `a3dd24e8-bde8-446b-98ac-dc17ed6a9868`. Twelve focused tests and local/production reusable relay smoke passed. Production browser verification covered two real Python shells, automatic tabs, keyboard/mouse switching, surviving sibling close with new command output, and reload without resurrecting old tabs.
- Public HTML may include Cloudflare's injected analytics beacon, so byte equality with `dist/*.html` can fail despite matching deployed app assets. Check the diff and asset hashes. Use the app's `raijin-agent/0.1 (+https://raijin.sh)` User-Agent for Python HTTP probes; default urllib requests received 403 during verification.
