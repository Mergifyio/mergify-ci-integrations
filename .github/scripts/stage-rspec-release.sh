#!/usr/bin/env bash
# Prepare clients/rspec-mergify/ for `rake build` / `rake release`.
#
# Two things the working tree deliberately does not carry, both staged here so
# the draft build and the publish build produce an identical gem:
#
#   VERSION  the tree pins the 0.0.0 placeholder every client here carries, so a
#            checkout never looks like a release; the tag is the source of truth.
#   LICENSE  the repo keeps one Apache-2.0 LICENSE at its root, but the gemspec
#            packages `LICENSE` relative to itself, so the published gem would
#            ship none unless it is copied next to the gemspec first.
#
# Both edits dirty the tree on purpose. That is why the Rakefile clears
# `release:guard_clean`.
set -euo pipefail

TAG="${1:?usage: stage-rspec-release.sh <rspec-mergify-v[SemVer]>}"

if ! [[ "${TAG}" =~ ^rspec-mergify-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::tag '${TAG}' must be rspec-mergify-v<major.minor.patch>" >&2
  exit 1
fi

version="${TAG#rspec-mergify-v}"
root="$(git rev-parse --show-toplevel)"
gem_dir="${root}/clients/rspec-mergify"
version_rb="${gem_dir}/lib/mergify/rspec/version.rb"

sed -i.bak -E "s/VERSION = '0\.0\.0'/VERSION = '${version}'/" "${version_rb}"
rm -f "${version_rb}.bak"

# A silent no-op sed would ship a 0.0.0 gem, so make the miss fatal.
if ! grep -q "VERSION = '${version}'" "${version_rb}"; then
  echo "::error::failed to stamp ${version} into ${version_rb#"${root}/"}" >&2
  exit 1
fi

cp "${root}/LICENSE" "${gem_dir}/LICENSE"

echo "staged ${TAG}:"
grep "VERSION = " "${version_rb}"
echo "  LICENSE -> $(head -2 "${gem_dir}/LICENSE" | tail -1 | sed 's/^ *//')"
