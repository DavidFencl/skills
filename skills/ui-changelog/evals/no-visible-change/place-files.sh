#!/usr/bin/env bash
# Builds the test repository in the current directory: the site is committed on main, and
# an uncommitted change to the dev server log line and the README is left in the working tree.
set -eu
src="$(cd "$(dirname "$0")" && pwd)/files"
cp -R "$src/base/." .
git init -q -b main
git add -A
git -c user.name="Fixture" -c user.email="fixture@example.com" commit -q -m "Riverside site"
cp -R "$src/change/." .
