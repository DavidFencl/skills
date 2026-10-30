#!/usr/bin/env bash
# Builds the test repository in the current directory: the site on main, and a feature branch with
# two commits (a menu button in the header, then its phone-only styles), checked out with a clean tree.
set -eu
src="$(cd "$(dirname "$0")" && pwd)/files"
commit() { git -c user.name="Fixture" -c user.email="fixture@example.com" commit -q -m "$1"; }
cp -R "$src/base/." .
git init -q -b main
git add -A
commit "Riverside site"
git checkout -q -b feature/mobile-menu
cp -R "$src/commit-1/." .
git add -A
commit "Add a menu button to the header"
cp -R "$src/commit-2/." .
git add -A
commit "Collapse the header navigation behind the menu on phones"
