# NomenAK fork: local patches and update procedure

The production Paperclip, Pi and `pi-cliproxyapi-provider` run from forks.
Each local change is **one commit** on a `deploy` branch based on the upstream
release that production runs. An upstream update is a rebase. Each patch can be
reverted on its own with `git revert <sha>` or by dropping it during a rebase.
Nothing is hand-patched in `dist/` or in installed packages any more.

| Repository | Fork | `deploy` base | Local checkout |
| --- | --- | --- | --- |
| paperclipai/paperclip | NomenAK/paperclip | `v2026.1001.0` | `~/Dev/paperclip-pi-parser` |
| earendil-works/pi | NomenAK/pi | `v1.0.0` | `~/Dev/pi-deploy` (worktree of `~/Dev/pi`) |
| 0xRichardH/pi-cliproxyapi-provider | NomenAK/pi-cliproxyapi-provider | `v0.15.50` (master `4b87e14`) | `~/Dev/pi-cliproxyapi-provider` |

Remotes in every checkout: `origin` = fork, `upstream` = original project
(push disabled).

## Patch inventory

Paperclip (`deploy` on `v2026.1001.0`, oldest first):

| Commit | Change | Origin |
| --- | --- | --- |
| `a588de49a` | pi-local: render Pi transcripts from completed messages | pi parser fix 2026-09-25 |
| `349359789` | pi-local: classify provider quota and transient failures | 2026-09-26 |
| `a523e164c` | run-dispatch: let the addressee of a pending interaction run on a non-owned issue | 2026-09-26 |
| `daa4247b1` | pi-local: fall back through ordered models on provider failures | 2026-09-26 |
| `d5528068b` | pi-local: classify OpenRouter mid-stream errors as transient | 2026-09-26 |
| `08b6d93c3` | built-in-agents: allow `pi_local` | 2026-09-26 |
| `d66338b60` | pi-local: fall back when the primary model is missing from the catalogue | 2026-09-26 |
| `6eb597049` | authz: block agent PATCH that implicitly drops a host provision command | DIO-63 |
| `6798d4ff6` | adapter-utils: never hand instance signing secrets to agent processes | DIO-475, DIO-457 |
| `c94fe5052` | pi-local: never respawn a Pi stopped by the control plane | DIO-443 v1+v2 |
| `9d6274fe4` | skills: ship `paperclip-issue-update.sh` with the paperclip skill | DIO-103 |
| `03154f86a` | fork tooling: `scripts/fork/pack-fork.sh` | fork |
| `63069cda0` | fork tooling: `scripts/fork/install-fork.sh` | fork |
| `f2ab4164e` | this document | fork |
| `bb28b49a8` | Pi Durable adapter assessment (`doc/plans/`) | fork |
| `bcaf96555` | pi-local: build agent env from the sanitized server env; denylist all instance secrets (`PAPERCLIP_DECISION_SIGNING_SECRET`, `PAPERCLIP_SECRETS_MASTER_KEY`, `DATABASE_URL`, `PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET` added) | Sauron audit A1 (root fix for DIO-457/475) |
| `52c21e80f` | pi-local: opt into `onCancellationReady` and honour `ctx.signal` between attempts; exit 143/130 kept as fallback heuristic | Sauron audit A2 (root fix for DIO-443) |
| `9723a146c` | authz: compare host commands before/after a policy replacement instead of blocking every agent policy edit | Sauron audit A3 (refines DIO-63) |
| `3fb519843` | adapter-utils: managed shell profiles prepend to the live `PATH` instead of restoring a frozen one | Sauron audit A4 (DIO-90) |
| `7f41c8707` | skills: `SKILL.md` resolves `paperclip-issue-update.sh` against the skill directory | Sauron audit A5 (DIO-210) |

Previous stacks: tags `deploy/2026.916.1-nomenak.1` (on `v2026.916.1`) and
`deploy/2026.1001.0-nomenak.1` (before the audit fixes). Audit:
`~/paperclip-audits/sauron-2026-10-02.md`.

Commit `b2a7a4bea` ("treat models missing from the catalogue as a soft
cooldown") was never deployed. It is kept on branch
`deploy-with-soft-cooldown` and is not part of `deploy`.

Pi (`deploy` on `v1.0.0`; previous stack: tag `deploy/0.87.1-nomenak.1`):

| Commit | Change |
| --- | --- |
| `d0ff703b0` | ai: retry OpenRouter "Error injected into SSE stream" failures |

pi-cliproxyapi-provider (`deploy` on master `4b87e14` = 0.15.50):

| Commit | Change |
| --- | --- |
| `fa134b7` | matching: index the models.dev catalog (slow pi startup) |

## Install layout

- Paperclip: `~/.local/share/paperclip-fork/<version>/` holds the tarballs and
  an `install/` npm project. `current` is a symlink to the running version.
  The systemd drop-in
  `~/.config/systemd/user/paperclipai.service.d/override.conf` runs
  `current/install/node_modules/paperclipai/dist/index.js`. The `paperclipai`
  command on `PATH` links to the same file. The agents' Pi skill link
  `~/.pi/agent/skills/paperclip` points through `current`, so it follows each
  install. Fork versions are `<upstream version>-nomenak.<n>`.
- Restart: `paperclipai service restart` hot-restarts and **adopts** live
  agent runs (`KillMode=process` in the drop-in keeps their processes alive;
  verified 2026-10-02, report `adoptedRunIds`, `lostRunIds` empty). Check
  `~/.paperclip/instances/default/hot-restart-report.json` after each restart:
  any `lostRunIds` entry is a failed restart. `--wait` drains instead.
- The drop-in `PATH` includes `~/.dotnet/tools` (ilspycmd); `pwsh` comes from
  global mise (`~/.config/mise/config.toml`).
- Pi: `npm install -g ~/.local/share/pi-fork/<tarball>`; `pi --version` shows
  the `-nomenak.<n>` suffix.
- pi-cliproxyapi-provider: pinned git package in `~/.pi/agent/settings.json`
  (`git:github.com/NomenAK/pi-cliproxyapi-provider@<sha>`).

Never run `npm install -g paperclipai`, `paperclipai install/upgrade` or
`npm install -g @earendil-works/pi-coding-agent`. Each of them replaces the
fork with the unpatched upstream build.

## Update procedure

Paperclip (example: from `v2026.1001.0` to `vNEXT`):

```bash
cd ~/Dev/paperclip-pi-parser
git fetch upstream --tags
git tag deploy/<current version> deploy && git push origin deploy/<current version>   # e.g. deploy/2026.1001.0-nomenak.2
git switch -c deploy-NEXT deploy
git rebase --onto vNEXT v2026.1001.0   # resolve conflicts per commit; drop commits upstream merged
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm test:run
scripts/fork/pack-fork.sh NEXT-nomenak.1
scripts/fork/install-fork.sh NEXT-nomenak.1   # moves `current`
paperclipai db:backup
# board-gated; hot restart adopts live runs and applies pending DB migrations on start
paperclipai service restart --json | jq '.report | {adoptedRunIds, lostRunIds}'   # lostRunIds must be empty
git branch -f deploy deploy-NEXT && git switch deploy && git branch -D deploy-NEXT
git push -f origin deploy vNEXT
```

Rollback: `ln -sfn <previous version> ~/.local/share/paperclip-fork/current`
and restart. Upstream migrations are additive (`IF NOT EXISTS`), so the
previous build runs on the migrated database. Restore the `db:backup` dump
only if a migration is destructive: read `packages/db/src/migrations/*.sql`
in the diff before upgrading. Keep the previous version directory until the
new one has run clean. Each version directory takes 1.4 to 1.6 GB.

Pi: tag the current `deploy` (`deploy/<ver>-nomenak.<n>`), then rebase
`deploy` onto the new tag in `~/Dev/pi-deploy`. Then run
`npm ci && npm run build`. In `packages/coding-agent`, run
`npm run shrinkwrap`, then set `"version"` in `package.json` to
`<ver>-nomenak.<n>`. Edit the file with `jq`: `npm version` fails because
the repo `.npmrc` sets `min-release-age=2`. Then run
`npm pack --pack-destination ~/.local/share/pi-fork`, run `npm install -g` on
the tarball, and finish with `git checkout -- .`. Before switching, compare
`pi --mode json -p` events and `pi --list-models` output between the old and
new builds: the pi-local adapter parses both.

pi-cliproxyapi-provider: rebase `deploy` onto `upstream/master`, run
`npm run check`, push. Then run
`pi remove git:github.com/NomenAK/pi-cliproxyapi-provider@<old>` and
`pi install git:github.com/NomenAK/pi-cliproxyapi-provider@<new sha>`.

Dropping a patch: during the rebase, mark its line `drop`. Upstream releases
that contain the same fix produce an empty commit, which `git rebase` drops on
its own.
