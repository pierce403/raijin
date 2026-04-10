# TODO

- Add small automated Worker tests for browser-owned session bootstrap parsing, origin checks, and Durable Object state transitions.
- Add better reconnection behavior if the browser reloads intentionally before the agent has started.
- Decide whether reconnect after a live browser disconnect should remain a hard stop or gain an opt-in short grace period.
- Improve agent shutdown reporting so the browser can distinguish explicit terminate, timeout, and natural process exit cleanly.
- Add optional session labels for easier operator context on multiple tabs.
- Add an opt-in short reconnect grace period if product requirements change.
- Evaluate chunk batching and output compression if sessions begin to move larger command output.
- Consider optional macOS support after Linux behavior is stable.
