# Remote Agent Notes

This project ships a generated remote bootstrap script, not a persistent installed agent.

## Goals

- zero-install
- Python 3 stdlib only
- Linux-first
- PTY-backed shell
- no persistence
- no files written to disk

## Runtime behavior

The bootstrap returned from `GET /bootstrap?c=...`:

1. embeds the session token and base URL
2. opens a PTY with `pty.fork()`
3. starts either:
   - `/bin/sh -li`
   - `/bin/sh -lc <forced command>`
4. long-polls `GET /agent/:sessionId/in` for input, resize, and terminate events
5. POSTs output chunks to `POST /agent/:sessionId/out`
6. POSTs heartbeats to `POST /agent/:sessionId/heartbeat`
7. POSTs shutdown state to `POST /agent/:sessionId/close`

## Supported modes

- `interactive`: normal shell input/output
- `command`: launches `/bin/sh -lc <command>`
- `readonly`: launches a shell but ignores browser `stdin`

## Shutdown conditions

The bootstrap kills the shell and exits when:

- it receives a `terminate` event
- the browser disconnects
- the session is explicitly ended
- the Worker reports an expired session
- the child shell exits on its own

## Scope

The bootstrap intentionally does not support:

- persistence
- auto-start
- background install
- stealth or hidden access
- Windows in v1

This is an ephemeral troubleshooting/admin bridge for systems the operator already controls.
