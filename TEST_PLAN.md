# Test Plan

## Manual local test

1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Open `http://localhost:8787`.
4. Create an interactive session.
5. Confirm the session page shows:
   - warning banner
   - bootstrap command
   - `Listening for connection...`
6. Paste the bootstrap command into a Linux shell you control.
7. Confirm the UI moves to `connected`.
8. Run a few commands from the browser:
    - `whoami`
    - `pwd`
    - `uname -a`
9. Resize the browser window and confirm the PTY follows.
10. Click `End Session` and confirm:
    - the browser status becomes `ended`
    - the WebSocket closes
    - the shell exits remotely

## Additional mode checks

1. Create a `command` session with `echo forced && id`.
2. Confirm the command runs and the session closes after the process exits.
3. Create a `readonly` session.
4. Confirm terminal output is visible but browser keyboard input is ignored.

## Disconnect behavior

1. Create an interactive session and connect the agent.
2. Close the browser tab or drop the WebSocket connection.
3. Confirm the session transitions to `disconnected`.
4. Confirm the remote shell exits.

## Timeout checks

For fast local testing, temporarily lower values in [wrangler.jsonc](/home/pierce/projects/raijin/wrangler.jsonc):

- `SESSION_IDLE_TIMEOUT_SECONDS`
- `SESSION_MAX_LIFETIME_SECONDS`

Then verify:

1. Idle sessions expire without browser input or shell output.
2. Active sessions still terminate at the hard lifetime ceiling.

## Build and deploy verification

1. Run `npm run build`.
2. Run `npx wrangler deploy --dry-run`.
3. Push to GitHub.
4. Connect the repository in Cloudflare Workers Builds.
5. Confirm the build command is `npm run build`.
6. Confirm the deploy command is `npx wrangler deploy`.
7. Confirm a push to the tracked branch triggers a successful deployment.
