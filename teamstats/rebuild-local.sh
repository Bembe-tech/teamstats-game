#!/bin/sh
# Local rebuild with the shortest break: build next to static/, copy the new
# index.html + hashed assets in (old hashed files stay, so open pages keep
# working), then restart the server (the master caches index.html).
cd "$(dirname "$0")/.."
node teamstats/inline-theme.cjs && npx prettier --write index.html > /dev/null
rm -rf static.new
npx vite build --outDir static.new > teamstats/last-build.log 2>&1 || {
    tail -20 teamstats/last-build.log
    exit 1
}
cp -r static.new/. static/ && rm -rf static.new
grep -E "built in" teamstats/last-build.log
