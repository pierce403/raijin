# raijin.sh

`raijin.sh` is a small Cloudflare Worker application for creating short-lived browser-to-terminal sessions on systems you control.

It serves static frontend assets, exposes the relay/bootstrap routes, and uses separate Durable Objects for reusable command listeners and per-session relay state. Both keep only in-memory state. The remote side is a Python 3 stdlib-only bootstrap that leaves no installed agent behind.

## What v1 does

- Creates a reusable command listener in the browser. Every execution starts an independent temporary session.
- Keeps session metadata in browser `localStorage`, not in server-side persistent storage.
- Shows a copyable one-line Python bootstrap command.
- Opens a live terminal in the browser with `xterm.js`.
- Runs `/bin/sh -li` by default inside a PTY on the remote Linux host.
- Supports `interactive`, `command`, and `readonly` session modes.
- Kills the shell and ends the session on browser disconnect, explicit end, idle expiry, or hard lifetime expiry.
- Keeps bounded transcripts in browser localStorage only.

## Stack

- Cloudflare Workers
- Cloudflare Durable Objects
- Static assets served by the same Worker project
- Vanilla HTML/CSS/JS frontend built with Vite
- `xterm.js` for the browser terminal
- Python 3 stdlib-only remote bootstrap

## Local development

### Prerequisites

- Node.js 20+ with `npm`
- Python 3
- Linux shell for realistic end-to-end testing

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

### Run locally

Use the one-command dev workflow:

```bash
npm run dev
```

That starts:

- `vite build --watch` to keep `dist/` current
- `wrangler dev --local --port 8787` for the Worker, assets, and Durable Objects

Open `http://localhost:8787`.

## Local smoke flow

1. Open the home page.
2. Click `New Session`.
3. Copy the bootstrap command from `/l/:launcherId` and leave that listener open.
4. Paste it into a Linux shell you control. Each execution requests a new terminal tab.
5. Allow popups for automatic tabs, or click that run's `Open Session` link. The agent waits about five minutes before starting its shell.
6. Run the identical command again and verify that it opens a separate session with isolated input/output.
7. Click `End Session` in one terminal and confirm only its shell exits. Reuse the same command after all shells exit.
8. Reopen saved listeners from `Recent Commands` on the homepage. Commands copied before this feature remain single-session commands; create a new listener to get a reusable one.

See [TEST_PLAN.md](/home/pierce/projects/raijin/TEST_PLAN.md) for the full manual checklist.

## Deployment to Cloudflare from GitHub

This repo is designed for Cloudflare Workers Builds.

### One-time setup

1. Push this repo to GitHub.
2. In Cloudflare, go to `Workers & Pages`.
3. Create a new application and choose `Import a repository`.
4. Select this repository.
5. Keep the project root at the repo root.
6. Set the build command to:

   ```bash
   npm run build
   ```

7. Set the deploy command to:

   ```bash
   npx wrangler deploy
   ```

8. Save and deploy.

### Important Cloudflare detail

Cloudflare Workers Builds expects the Worker name in the dashboard to match the `name` field in [wrangler.jsonc](/home/pierce/projects/raijin/wrangler.jsonc). This repo uses `raijin`.

### Custom domain

After the first deploy, add `raijin.sh` as a custom domain in Cloudflare. The bootstrap command uses the current origin, so it works with either the generated `workers.dev` host or the final custom domain.

## Project layout

- [src/index.js](/home/pierce/projects/raijin/src/index.js): Worker routes and bootstrap generation
- [src/launcher-do.js](src/launcher-do.js): in-memory reusable-command registration and browser notifications
- [src/frontend/launcher.js](src/frontend/launcher.js): reusable command UI, new tabs, and popup fallback
- [src/session-do.js](/home/pierce/projects/raijin/src/session-do.js): session Durable Object
- [src/frontend/home.js](/home/pierce/projects/raijin/src/frontend/home.js): home page UI
- [src/frontend/session.js](/home/pierce/projects/raijin/src/frontend/session.js): session page UI and terminal client
- [src/frontend/session-store.js](/home/pierce/projects/raijin/src/frontend/session-store.js): browser-owned session metadata and bootstrap generation
- [wrangler.jsonc](/home/pierce/projects/raijin/wrangler.jsonc): Worker config, assets, Durable Object binding, migrations

## Verification

Verified locally on April 10, 2026 with:

- `npm run build`
- `npx wrangler deploy --dry-run`
- local `wrangler dev` smoke tests covering create session, websocket connect, Python bootstrap connect, terminal output, resize, explicit end, and shell cleanup

### Reusable-command regression checks

```bash
node --test tests/bootstrap.test.mjs tests/launcher.test.mjs
# With wrangler dev running:
node tests/relay-smoke.mjs
node tests/reusable-smoke.mjs
```

The runtime suite covers simultaneous real Python PTYs, independent credentials and I/O, reuse after exit, idempotent registration, browser readiness, and stale socket closure. Use `RAIJIN_TEST_URL=https://raijin.sh` to run either smoke script against production with fresh test sessions.

The listener accepts at most 100 registrations in a ten-minute window. Registration and tab startup wait about five minutes in the agent. Closing the listener stops new registrations until it is reopened; existing terminal tabs keep running independently. No server session or listener state survives a Worker restart.
