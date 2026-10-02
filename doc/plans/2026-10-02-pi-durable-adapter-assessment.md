# Pi Durable adapter: assessment (2026-10-02)

Decision: **do not build a `pi_durable` adapter now.** Revisit when a trigger
below is met.

## What Pi Durable is

`@earendil-works/pi-durable` 1.0.0 (published 2026-10-01). Its README says:
"**Experimental.** The API changes without notice between releases."

It is a library. It commits every model turn, streamed partial and tool call
to storage (SQLite, JSONL or memory) before showing it. After a crash it
resumes from the last commit. It also offers:

- steer and follow-up inputs into a running conversation;
- task-owned subagents;
- per-conversation agent configuration;
- usage documents.

The only coding agent built on it ships with Pi 1.0.0 as the experimental
TUI demo `packages/coding-agent/src/experimental/durable/`. That demo:

- is not in the npm package (`dist/` has no `experimental/`);
- runs only from source;
- has no `-p` / `--mode json`;
- does not load Pi extensions ("Not here: … extensions"). Our `cpa/*` and
  `omni/*` models come from extensions.

## What it would fix here

Measured over the 7 days to 2026-10-02: 1,523 `pi_local` runs.

| Failure | Runs | Fixed by Durable |
| --- | --- | --- |
| `server_shutdown_interrupted` | 10 | yes |
| `orphaned_running_run` | 6 | yes |
| `process_lost` | 1 | yes |
| Provider and model errors (unavailable model, quota, 429, SSE, `--list-models` timeout) | ~85 | no |
| Control-plane cancellations (`issue_reassigned`, `workspace_busy`, …) | ~245 | no |
| `Pi exited with code 143` | 28 | no; deliberate stops, handled by DIO-443 |

Paperclip already resumes Pi sessions (`--session`) and recovers runs:

- bootstrap replay of interrupted runs (`executionRecovery`);
- orphaned-run reconciliation.

Durable would partly duplicate both.

## Cost

- No usable CLI exists. The adapter would have to embed the Harness, either in
  the Paperclip server or in our own runner script.
- It would build on an API that changes between releases, as a new runtime we
  maintain.
- It would need the CPA/omni model wiring, model fallback, cooldowns, DIO-443
  and the secret stripping re-done.
- Steering a running run, the one new capability, has no adapter contract in
  Paperclip. It would need a core change too.

## Triggers to revisit

- pi-durable drops "Experimental", and the `pi` CLI exposes a durable mode with
  JSON output and extension loading.
- Paperclip gains a contract for delivering messages into an active adapter
  run. Durable would then be the natural Pi backend for it.

The larger remaining loss is model availability: unavailable-model errors,
`--list-models` timeouts and quotas.
