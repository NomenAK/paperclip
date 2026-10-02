#!/usr/bin/env bash
# install-fork.sh — Install the paperclipai CLI from tarballs built by
# pack-fork.sh into a self-contained prefix, then point a stable symlink at it.
#
# Usage: scripts/fork/install-fork.sh <version> [prefix-root]
#   prefix-root  default: ~/.local/share/paperclip-fork
#
# Layout:
#   <prefix-root>/<version>/*.tgz         tarballs (pack-fork.sh output)
#   <prefix-root>/<version>/install/      npm project with node_modules
#   <prefix-root>/current -> <version>    what the service runs
#
# Every @paperclipai/* dependency is forced to its local tarball with npm
# "overrides", so the fork version never resolves against the npm registry.
# Third-party dependencies still come from the registry/cache as usual.
# Switching versions (or rolling back) is: ln -sfn <version> current, restart.
set -euo pipefail

VERSION="${1:?usage: install-fork.sh <version> [prefix-root]}"
ROOT="${2:-$HOME/.local/share/paperclip-fork}"
TARBALLS="$ROOT/$VERSION"
INSTALL="$TARBALLS/install"

[ -f "$TARBALLS/paperclipai-$VERSION.tgz" ] || {
  echo "install-fork: no paperclipai-$VERSION.tgz in $TARBALLS (run pack-fork.sh first)" >&2
  exit 1
}

rm -rf "$INSTALL"
mkdir -p "$INSTALL"
node - "$TARBALLS" "$INSTALL/package.json" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [dir, out] = process.argv.slice(2);
const overrides = {};
let cli = null;
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".tgz"))) {
  // Tarball names are <scope>-<name>-<version>.tgz; read the real name inside.
  const name = require("node:child_process")
    .execFileSync("tar", ["-xOzf", path.join(dir, file), "package/package.json"])
    .toString();
  const pkgName = JSON.parse(name).name;
  const spec = `file:${path.join(dir, file)}`;
  if (pkgName === "paperclipai") cli = spec;
  else overrides[pkgName] = spec;
}
if (!cli) throw new Error("paperclipai tarball not found");
fs.writeFileSync(out, JSON.stringify({
  name: "paperclip-fork-install",
  private: true,
  dependencies: { paperclipai: cli },
  overrides,
}, null, 2) + "\n");
NODE

(cd "$INSTALL" && npm install --omit=dev --no-audit --no-fund)
"$INSTALL/node_modules/.bin/paperclipai" --version
ln -sfn "$VERSION" "$ROOT/current"
echo "Installed; $ROOT/current -> $VERSION"
echo "Service binary: $ROOT/current/install/node_modules/paperclipai/dist/index.js"
