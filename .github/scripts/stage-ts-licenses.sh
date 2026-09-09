#!/usr/bin/env bash
# Copy the root LICENSE into every npm package under clients/ts/.
#
# The repo keeps a single Apache-2.0 LICENSE at its root, but npm packs each
# package from its own directory and nothing outside that directory ships. All
# eleven packages went out through 0.3.7 carrying no licence text at all, while
# the wheels and the gem have always shipped theirs -- see
# build-pytest-mergify-wheels.yml and stage-rspec-release.sh, which solve the
# same problem the same way.
#
# No manifest changes are needed: npm always packs a LICENSE it finds in the
# package directory, whether or not the `files` array mentions it, and even when
# .gitignore covers it -- which is why the copies below can stay ignored.
#
# Two sets of packages need one, and only the first is a pnpm workspace:
# pnpm-workspace.yaml globs `packages/*`, so the seven napi platform packages
# under packages/native/npm/* are invisible to `pnpm -r` and are handled
# separately by the release workflow too.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
license="${root}/LICENSE"
ts="${root}/clients/ts"

# The platform directories are populated by `napi artifacts`, so callers must
# run this after that step -- staging first would risk the copies being cleaned
# out from under them.
copied=0
for dir in "${ts}"/packages/*/ "${ts}"/packages/native/npm/*/; do
  [ -f "${dir}package.json" ] || continue
  cp "${license}" "${dir}LICENSE"
  copied=$((copied + 1))
done

# A glob that matches nothing expands to nothing and this loop would then exit 0
# having done nothing at all -- exactly the silent success that let eleven
# unlicensed packages ship. Adding a package is fine and needs no edit here;
# losing one means the globs no longer describe the workspace.
minimum=11
if [ "${copied}" -lt "${minimum}" ]; then
  echo "::error::staged ${copied} LICENSE copies, expected at least ${minimum} -- the globs in ${0##*/} no longer match the workspace" >&2
  exit 1
fi

echo "staged ${copied} LICENSE copies under clients/ts/"
