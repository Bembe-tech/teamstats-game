#!/bin/sh
# Copies the committed stream-game tree (branch teamstats) into the public repo
# folder ../teamstats-game-repo as it is published: no proprietary/, our
# Dockerfile and README at the root. Commits there; pushing is a separate step.
# Usage: sh teamstats/sync-public-repo.sh "commit message"
set -e
cd "$(dirname "$0")/.."
SRC="$(pwd)"
DST="$SRC/../teamstats-game-repo"
MSG="${1:-Update from stream-game}"
[ -d "$DST/.git" ] || { echo "no $DST"; exit 1; }
cd "$DST"
git ls-files -z | xargs -0 rm -f
(cd "$SRC" && git archive --format=tar HEAD) | tar -x -C "$DST"
rm -rf proprietary
mv README.md README-OPENFRONT.md
cp teamstats/README.md README.md
sed -i 's#Dockerfile path `teamstats/Dockerfile`#Dockerfile in the repo root#' README.md
mv Dockerfile Dockerfile.openfront
cp teamstats/Dockerfile Dockerfile
sed -i 's#^\# Build from the repo root:  docker build -f teamstats/Dockerfile .#\# Build from the repo root:  docker build .#' Dockerfile
sed -i 's#^Dockerfile\*$#Dockerfile.openfront#; s#^README.md$##' .dockerignore
git add -A
if git diff --cached --quiet; then echo "nothing to commit"; exit 0; fi
git -c user.name=Bembe -c user.email=douge4316@gmail.com commit -q -m "$MSG

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git log --oneline -1
git diff --stat HEAD~1 | tail -1
