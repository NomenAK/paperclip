# NomenAK fork: local patches and update procedure

The production Paperclip, Pi and `pi-cliproxyapi-provider` run from forks.
Each local change is **one commit** on a `deploy` branch based on the upstream
release that production runs. An upstream update is a rebase. Each patch can be
reverted on its own with `git revert <sha>` or by dropping it during a rebase.
Nothing is hand-patched in `dist/` or in installed packages any more.

| Repository | Fork | `deploy` base | Local checkout |
| --- | --- | --- | --- |
| paperclipai/paperclip | NomenAK/paperclip | `v2026.916.1` | `~/Dev/paperclip-pi-parser` |
| earendil-works/pi | NomenAK/pi | `v0.87.1` | `~/Dev/pi-deploy` (worktree of `~/Dev/pi`) |
| 0xRichardH/pi-cliproxyapi-provider | NomenAK/pi-cliproxyapi-provider | `v0.15.50` (master `4b87e14`) | `~/Dev/pi-cliproxyapi-provider` |

Remotes in every checkout: `origin` = fork, `upstream` = original project
(push disabled).

## Patch inventory

Paperclip (`deploy` on `v2026.916.1`, oldest first):

| Commit | Change | Origin |
| --- | --- | --- |
| `9422d3fd5` | pi-local: render Pi transcripts from completed messages | pi parser fix 2026-09-25 |
| `6dada43f3` | pi-local: classify provider quota and transient failures | 2026-09-26 |
| `b76cb392b` | run-dispatch: let the addressee of a pending interaction run on a non-owned issue | 2026-09-26 |
| `47f24e999` | pi-local: fall back through ordered models on provider failures | 2026-09-26 |
| `643581b66` | pi-local: classify OpenRouter mid-stream errors as transient | 2026-09-26 |
| `5440fbc4a` | built-in-agents: allow `pi_local` | 2026-09-26 |
| `33ea5d257` | pi-local: fall back when the primary model is missing from the catalogue | 2026-09-26 |
| `565118f0f` | authz: block agent PATCH that implicitly drops a host provision command | DIO-63 |
| `d7f556b68` | adapter-utils: never hand instance signing secrets to agent processes | DIO-475, DIO-457 |
| `69bb16c4d` | pi-local: never respawn a Pi stopped by the control plane | DIO-443 v1+v2 |
| `35a532535` | skills: ship `paperclip-issue-update.sh` with the paperclip skill | DIO-103 |
| `4323c1c5e` | fork tooling: `scripts/fork/pack-fork.sh` | fork |
| `9635fe48d` | fork tooling: `scripts/fork/install-fork.sh` | fork |

Commit `b2a7a4bea` ("treat models missing from the catalogue as a soft
cooldown") was never deployed. It is kept on branch
`deploy-with-soft-cooldown` and is not part of `deploy`.

Pi (`deploy` on `v0.87.1`):

| Commit | Change |
| --- | --- |
| `ae0f2aae1` | ai: retry OpenRouter "Error injected into SSE stream" failures |

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
  command on `PATH` links to the same file. Fork versions are
  `<upstream version>-nomenak.<n>`.
- Pi: `npm install -g ~/.local/share/pi-fork/<tarball>`; `pi --version` shows
  the `-nomenak.<n>` suffix.
- pi-cliproxyapi-provider: pinned git package in `~/.pi/agent/settings.json`
  (`git:github.com/NomenAK/pi-cliproxyapi-provider@<sha>`).

Never run `npm install -g paperclipai`, `paperclipai install/upgrade` or
`npm install -g @earendil-works/pi-coding-agent`. Each of them replaces the
fork with the unpatched upstream build.

## Update procedure

Paperclip (example `v2026.1001.0`):

```bash
cd ~/Dev/paperclip-pi-parser
git fetch upstream --tags
git switch -c deploy-2026.1001.0 deploy
git rebase --onto v2026.1001.0 v2026.916.1   # resolve conflicts per commit; drop commits upstream merged
pnpm install --frozen-lockfile
pnpm -r typecheck && pnpm test:run
scripts/fork/pack-fork.sh 2026.1001.0-nomenak.1
scripts/fork/install-fork.sh 2026.1001.0-nomenak.1   # moves `current`
# board-gated: no run in progress (heartbeat_runs.status running/queued = 0)
systemctl --user restart paperclipai.service
git push origin deploy-2026.1001.0 && git branch -f deploy deploy-2026.1001.0 && git push -f origin deploy
```

Rollback: `ln -sfn <previous version> ~/.local/share/paperclip-fork/current`
and restart. Keep the previous version directory until the new one has run
clean. Each version directory takes about 1.6 GB.

Pi: rebase `deploy` onto the new tag in `~/Dev/pi-deploy`. Then run
`npm ci && npm run build`. In `packages/coding-agent`, run
`npm run shrinkwrap`, then `npm version --no-git-tag-version <ver>-nomenak.<n>`,
then `npm pack --pack-destination ~/.local/share/pi-fork`. Finally run
`npm install -g` on the tarball and `git checkout -- .`.

pi-cliproxyapi-provider: rebase `deploy` onto `upstream/master`, run
`npm run check`, push. Then run
`pi remove git:github.com/NomenAK/pi-cliproxyapi-provider@<old>` and
`pi install git:github.com/NomenAK/pi-cliproxyapi-provider@<new sha>`.

Dropping a patch: during the rebase, mark its line `drop`. Upstream releases
that contain the same fix produce an empty commit, which `git rebase` drops on
its own.
