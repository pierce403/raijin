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
