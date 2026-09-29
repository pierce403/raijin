# First agent output investigation

The reported production crash remains unconfirmed. Both the checked-out Worker and the deployed site accepted the exact `{"data":"IyA="}` output payload with the browser attached and with the browser detached before agent arrival. Each case included a concurrent `/in` poll and repeated output/heartbeat requests. Closing the test session resolved the poll and subsequent output returned 410.

The server is a JavaScript Cloudflare Worker with per-session Durable Objects. Output already checks for an open browser socket and otherwise acknowledges and drops the data. The outer Worker catches request exceptions. A 409 means the object has no initialized session; that alone does not establish a process crash or restart. No historical exception logs for the reported failure window were retrieved. The live tail attempt did not establish a log stream.

The confirmed bootstrap weakness was that one timeout, connection reset, or 5xx ended the agent. Requests now retry up to three attempts with short backoff, while terminal HTTP errors still stop immediately. The output loop also retains the current chunk while a 409 indicates that browser initialization is pending. Previously it discarded that chunk.

Retries are not exactly-once delivery: a lost response can cause duplicate terminal output, and a lost long-poll response can lose input already dequeued by the server. This change does not restore lost in-memory session state or change the policy that browser disconnect after agent attachment ends the session.

Verification:

- `npm run build`
- `node --test tests/bootstrap.test.mjs` (six Python cases)
- `node tests/relay-smoke.mjs` against local Wrangler, including the actual generated bootstrap and a fixed printf command under a PTY
- `npx wrangler deploy --dry-run`
- Production attached/detached HTTP relay reproduction passed before the change

A recurrence needs a correlated Cloudflare exception record and client request timing/response headers, including CF-Ray when available. The original proxy path was not available for reproduction here.

## Deployment

Deployed application commit `a991501` on 2026-09-29 using `npm run build && npm run deploy`. Cloudflare Worker version: `c175a3ff-cffb-42fc-803f-fe86949f8d15`.

Post-deploy checks on https://raijin.sh passed: homepage HTTP 200, generated bootstrap byte-for-byte comparison against the committed generator, attached and detached relay cases, and the actual Python bootstrap executing a fixed printf command under a PTY. The original reported crash remains unconfirmed.

## Historical Cloudflare analytics follow-up

Queried Cloudflare GraphQL for `raijin` and host `raijin.sh`, 2026-09-29 15:45–16:00 UTC (08:45–09:00 PDT). HTTP analytics reported sampleInterval 1 for the relevant rows. These are minute-grouped edge HTTP records, not packet captures or historical exception logs.

| PDT minute | Session | Observed edge responses |
| --- | --- | --- |
| 08:51 | `jinoxmA6CVJZZQlW` | `/out` 200; `/in` 200 x3; `/close` 200 |
| 08:52 | `1tScbkflSFUZic64` | `/out`, `/in`, `/close` all 200 |
| 08:53 | `1tScbkflSFUZic64` | `/api/sessions/.../end` 200 |
| 08:54 | `1tScbkflSFUZic64` | `/out`, `/in`, `/heartbeat` all 409 |
| 08:57 | `T_ajSjirMUN6bJQV` | `/out`, `/in`, `/close` all 409 |
| 08:57 | `T_ajSjirMUN6bJVQ` | `/out`, `/in`, `/heartbeat` all 409 |

The third run has two distinct IDs: the browser upgraded `/connect/browser/T_ajSjirMUN6bJQV` at 08:56, while the report named `T_ajSjirMUN6bJVQ`. Both variants received agent requests. This mismatch can explain uninitialized-session responses for the wrong ID, but does not explain every reported symptom. A 101 upgrade alone does not prove an authenticated browser hello completed.

Worker analytics returned 71 `success` invocations, five `responseStreamDisconnected`, and zero execution errors. Disconnect buckets: 08:47 x1, 08:51 x1, 08:53 x2, 08:56 x1. These counts and minute buckets match the five browser WebSocket upgrades in HTTP analytics; the datasets do not directly join each disconnect to a path. Do not attribute these five outcomes to `/out` failures.

Cloudflare records successful HTTP responses for the first two `/out` requests, not a Worker crash. This does not prove the agent received those responses or identify who closed the transport. Successful `/close` requests are also consistent with the bootstrap's failure cleanup ending the session; minute aggregation does not establish within-minute ordering.

Logging availability: script settings returned `observability: null`, `logpush: false`, and `tail_consumers: []`. The Workers telemetry query API returned 403 with the available OAuth credential, while GraphQL analytics succeeded. A bounded live `wrangler tail raijin --format json` worked: a fresh uninitialized-session probe returned HTTP 409 at both Worker and DO, outcome `ok`, and no exceptions. No production logging settings were changed.

To distinguish a future failure, correlate the same session/path and precise time in live tail with the agent's transport trace. `response.status` distinguishes HTTP 409 from execution outcome `ok`; cancellation/disconnection alone does not establish that a proxy initiated the close. Cloudflare defines response-stream disconnects as termination during deferred proxying, commonly seen with WebSockets: https://developers.cloudflare.com/workers/observability/errors/.
