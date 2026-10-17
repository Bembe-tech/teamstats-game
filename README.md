# TeamStats.Pro game

A modified build of [OpenFront](https://github.com/openfrontio/OpenFrontIO)
(AGPL-3.0) for private lobbies: a host with the secret link creates a lobby and
invites players with a link or code. Not affiliated with or endorsed by
OpenFront. © OpenFront and Contributors.

## What is different from OpenFront

- No OpenFront accounts, store, ads, ranked queue, public lobbies or game archive
  (`ServerEnv.openFrontApi()` is false; the client never calls their API).
- Host panel only with the key: `/?key=<ACCESS_KEY>` sets a cookie; without it
  `/` shows an invite page (paste link or code). Join links `/game/<id>` are open.
- Lobby modes: Fog of War, King of the Hill (length in minutes), Self Economy
  (no trade with other players, own ports trade with each other, trains 35k a
  stop), manual teams (host drags players), guests change their nickname,
  scheduled start ("Start in"), host may start alone.
- TeamStats.Pro look: `teamstats/theme.css` (inlined into `index.html` by
  `teamstats/inline-theme.cjs`), own logo/icon in `teamstats/brand/`
  (OpenFront's `proprietary/` assets are never used).
- One player per browser tab (persistent ID in sessionStorage).

## Run locally

```sh
npm ci --ignore-scripts
sh teamstats/rebuild-local.sh # client build into static/
ACCESS_KEY=secret PORT=8095 sh teamstats/start.sh
```

Open `http://localhost:8095/?key=secret`. `teamstats/front.cjs` is the single
public port (it does what OpenFront's nginx.conf does: `/wN/...` to worker N,
everything else to the master on 3000).

## Deploy (not done yet, waits for Bembe)

1. Public GitHub repo (AGPL: the source of the running version must be public);
   delete `proprietary/` before the first push.
2. Railway service from the repo, Dockerfile in the repo root,
   variables `ACCESS_KEY` and `DOMAIN`, a domain (e.g. play.teamstats.pro).
3. Add a "Source code" link to the repo in the footer and on the invite page.

Idle memory about 250–400 MB; the game itself runs in the players' browsers.
