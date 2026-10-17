#!/bin/sh
# TeamStats.Pro game: OpenFront's server (master :3000 + workers :3001..) and our front proxy on $PORT.
# Needs a built client in static/ (npx vite build). ACCESS_KEY = the secret of the host link (/?key=...).
cd "$(dirname "$0")/.."
export GAME_ENV="${GAME_ENV:-prod}"
export NUM_WORKERS="${NUM_WORKERS:-1}"
export INSTANCE_LETTER="${INSTANCE_LETTER:-a}"
export DOMAIN="${DOMAIN:-localhost}"
export GIT_COMMIT="${GIT_COMMIT:-$(git rev-parse --short HEAD 2> /dev/null || echo 0000000)}"
export TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-none}"
export API_KEY="${API_KEY:-$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')}"
export ADMIN_BOT_API_KEY="${ADMIN_BOT_API_KEY:-$API_KEY}"
node teamstats/front.cjs &
exec npx tsx src/server/Server.ts
