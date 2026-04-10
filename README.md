# raijin.sh

`raijin.sh` is a small Cloudflare Worker application for creating short-lived browser-to-terminal sessions on systems you control.

It serves static frontend assets, exposes the relay/bootstrap routes, and binds a Durable Object namespace for per-session in-memory relay state. The remote side is a Python 3 stdlib-only bootstrap that leaves no installed agent behind.

## What v1 does

- Creates a temporary session from the browser.
- Keeps session metadata in browser `localStorage`, not in server-side persistent storage.
- Shows a copyable one-line Python bootstrap command.
- Opens a live terminal in the browser with `xterm.js`.
- Runs `/bin/sh -li` by default inside a PTY on the remote Linux host.
- Supports `interactive`, `command`, and `readonly` session modes.
- Kills the shell and ends the session on browser disconnect, explicit end, idle expiry, or hard lifetime expiry.
- Stores no transcript by default.

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
3. Copy the bootstrap command from `/s/:sessionId`.
4. Paste it into a Linux shell you control.
5. Verify the terminal becomes interactive in the browser.
6. Resize the browser and confirm the shell follows.
7. Click `End Session` and confirm the shell exits remotely.

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
