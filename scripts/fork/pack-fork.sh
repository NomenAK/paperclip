#!/usr/bin/env bash
# pack-fork.sh — Build npm tarballs of every public package from the current
# checkout, the way scripts/release.sh builds them, without publishing.
#
# Usage: scripts/fork/pack-fork.sh <version> [out-dir]
#   <version>  version written into every package, e.g. 2026.916.1-nomenak.1
#   out-dir    tarball directory (default: ~/.local/share/paperclip-fork/<version>)
#
# The working tree is restored on exit (same cleanup as release.sh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI_DIR="$REPO_ROOT/cli"
VERSION="${1:?usage: pack-fork.sh <version> [out-dir]}"
OUT_DIR="${2:-$HOME/.local/share/paperclip-fork/$VERSION}"

# shellcheck source=../release-lib.sh
. "$REPO_ROOT/scripts/release-lib.sh"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "pack-fork: working tree is dirty; commit or stash first." >&2
  exit 1
fi

cleanup() {
  rm -rf "${PNPM_SHIM_DIR:-}"
  if [ -f "$CLI_DIR/package.dev.json" ]; then
    mv "$CLI_DIR/package.dev.json" "$CLI_DIR/package.json"
  fi
  rm -f "$CLI_DIR/README.md"
  rm -rf "$REPO_ROOT/server/ui-dist"
  for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
    rm -rf "$REPO_ROOT/${pkg_dir:?}/skills"
  done
  git -C "$REPO_ROOT" checkout -q -- .
}
trap cleanup EXIT

export PAPERCLIP_RELEASE_REUSE_UI_DIST=1
cd "$REPO_ROOT"
# Standalone plugin packages carry no packageManager field, so a newer global
# pnpm (>= 10 refuses dependency build scripts by default) would be picked up.
# Pin every nested pnpm call to the repo's version, as CI does.
PNPM_SHIM_DIR="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-fork-pnpm.XXXXXX")"
REPO_PNPM="$(jq -r .packageManager "$REPO_ROOT/package.json")"
printf '#!/bin/sh\nexec corepack %s "$@"\n' "$REPO_PNPM" > "$PNPM_SHIM_DIR/pnpm"
chmod +x "$PNPM_SHIM_DIR/pnpm"
export PATH="$PNPM_SHIM_DIR:$PATH"
pnpm build
node scripts/build-standalone-public-packages.mjs
bash scripts/prepare-server-ui-dist.sh
for pkg_dir in server packages/adapters/claude-local packages/adapters/codex-local; do
  rm -rf "$REPO_ROOT/$pkg_dir/skills"
  cp -r "$REPO_ROOT/skills" "$REPO_ROOT/$pkg_dir/skills"
done

node scripts/release-package-map.mjs set-version "$VERSION"
scripts/build-npm.sh --skip-checks --skip-typecheck

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
while IFS=$'\t' read -r pkg_dir pkg_name _pkg_version; do
  [ -n "$pkg_dir" ] || continue
  cd "$REPO_ROOT/$pkg_dir"
  if [ "$(package_publish_tool)" = "npm" ]; then
    stage="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-fork-pack.XXXXXX")"
    node "$REPO_ROOT/scripts/prepare-bundled-package.mjs" "$REPO_ROOT/$pkg_dir" "$stage"
    (cd "$stage" && run_bundled_npm_pack pack --pack-destination "$OUT_DIR" >/dev/null)
    rm -rf "$stage"
  else
    pnpm pack --pack-destination "$OUT_DIR" >/dev/null
  fi
  echo "  packed $pkg_name"
done <<< "$(node "$REPO_ROOT/scripts/release-package-map.mjs" list)"

git -C "$REPO_ROOT" rev-parse HEAD > "$OUT_DIR/SOURCE_COMMIT"
echo "Tarballs in $OUT_DIR"
