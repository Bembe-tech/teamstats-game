# TeamStats.Pro game server (OpenFront fork) for Railway or any Docker host.
# Build from the repo root:  docker build .
# Runtime env: PORT (Railway sets it), ACCESS_KEY (secret of the host link /?key=...),
# optional NUM_WORKERS (default 1), DOMAIN (the public host name).
FROM node:24-slim

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    GAME_ENV=prod \
    NUM_WORKERS=1 \
    INSTANCE_LETTER=a

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
# Client build: theme inlined into index.html, then Vite into static/
RUN node teamstats/inline-theme.cjs && npx vite build \
 && rm -rf proprietary

EXPOSE 8080
CMD ["sh", "teamstats/start.sh"]
