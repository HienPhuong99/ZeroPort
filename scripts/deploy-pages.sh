#!/usr/bin/env bash
# Publishes the web controller to the gh-pages branch (served at https://hienphuong99.github.io/ZeroPort/).
# Stop-gap for .github/workflows/pages.yml, which needs a token with the `workflow` scope to be pushed.
set -euo pipefail
cd "$(dirname "$0")/.."
npx tsc --noEmit
npx vite build
cd dist
touch .nojekyll
rm -rf .git
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C .. config user.name)" -c user.email="$(git -C .. config user.email)" commit -qm "deploy $(git -C .. rev-parse --short HEAD)"
git push -f "$(git -C .. remote get-url origin)" gh-pages
rm -rf .git
