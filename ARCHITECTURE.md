# Architecture

## Overview

`raijin.sh` is one Cloudflare Workers project with three responsibilities:

1. Serve static frontend assets from `dist/`
2. Expose session/bootstrap/agent API routes
3. Bind a Durable Object namespace with one Durable Object per session

The browser owns the session metadata and stores it in `localStorage`. The Durable Object only keeps in-memory relay state while the session is live. The remote Python bootstrap stays dependency-free and uses plain HTTP long-polling plus POSTs.

## Main flow

1. Browser generates `sessionId`, `browserToken`, and `agentToken`
2. Browser stores that session bundle in `localStorage`
3. Browser navigates to `/s/:sessionId`
4. Session page builds the bootstrap command locally
5. Session page connects `GET /connect/browser/:sessionId` with WebSocket upgrade
6. Browser sends a `hello` message containing the browser token plus hashed agent token and session config
7. User runs the bootstrap command in a Linux shell they control
8. Bootstrap script fetches `GET /bootstrap?c=...`
9. Script opens a PTY and starts `/bin/sh -li` or `/bin/sh -lc <command>`
10. Agent long-polls `GET /agent/:sessionId/in`
11. Agent posts output to `POST /agent/:sessionId/out`
12. Durable Object forwards output to the browser WebSocket
13. Session ends on browser disconnect after agent attach, explicit end, idle timeout, max lifetime, or agent exit

## Route map

- `POST /api/sessions/:sessionId/end`
  Authenticated browser endpoint to end the session explicitly.

- `GET /bootstrap?c=...`
  Returns a Python 3 stdlib-only script customized from browser-supplied bootstrap config.

- `GET /connect/browser/:sessionId`
  Browser WebSocket upgrade path. Worker verifies browser token and forwards the request into the Durable Object.

- `GET /agent/:sessionId/in`
  Agent long-poll endpoint for queued browser events.

- `POST /agent/:sessionId/out`
  Agent output chunks back to the Durable Object. Output is forwarded to the browser, not stored.

- `POST /agent/:sessionId/heartbeat`
  Agent liveness signal. This does not reset the idle timer.

- `POST /agent/:sessionId/close`
  Agent shutdown notice.

## Durable Object responsibilities

The session Durable Object keeps only ephemeral in-memory session state:

- browser WebSocket reference
- hashed browser token
- hashed agent token
- mode and session metadata
- current connection state
- pending browser-to-agent event queue
- expiry timestamps

It does not store terminal transcripts or persist session state to Durable Object storage.

## Session states

- `waiting_for_browser`
- `waiting_for_agent`
- `connected`
- `expired`
- `disconnected`
- `ended`
- `agent_closed`

The browser page displays these states directly.

## Event protocol

Browser to agent:

- `stdin`
- `resize`
- `terminate`

Durable Object to browser:

- `status`
- `notice`
- `output`

`output` data is base64-encoded so terminal byte streams survive JSON transport cleanly.

## Token model

Two independent random bearer tokens are created by the browser per session:

- browser token
- agent token

The browser stores the raw tokens in `localStorage`.

The Durable Object stores only token hashes in memory while the session is live. It does not persist them to storage.

## Timeouts

- idle timeout: 10 minutes by default
- hard max lifetime: 60 minutes by default
Timeouts are enforced opportunistically during live browser messages, agent polls, agent heartbeats, and agent output posts. There is no persistent timer state on the server.

## Security controls

- HTTPS/WSS in production
- strict same-origin checks on browser API and WebSocket requests
- strict CSP on HTML pages
- no `innerHTML` terminal rendering
- no transcript storage
- no uploads, downloads, clipboard sync, or hidden access paths
- visible warning banner in the UI
- one browser and one agent per session

## Why this split

The browser gets responsive terminal behavior over WebSocket, while the remote side stays easy to audit:

- no persistent daemon
- no `pip install`
- no compiled binary
- no disk writes
- stdlib-only Python bootstrap

That is the main design goal for v1.
