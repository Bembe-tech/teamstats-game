// TeamStats.Pro game: one public port in front of OpenFront's master (3000) and worker (3001),
// doing what nginx.conf does on OpenFront's own servers: /wN/... goes to worker N (path without
// the /wN prefix), /api/create_game to a worker, everything else to the master. WebSockets too.
// Also the gate: without the access cookie only /join/<id> links (and what the game loads) work;
// /?key=<ACCESS_KEY> sets the cookie and opens the host panel.
// Everyone logged in with Discord on teamstats.pro may host too: the site's /play hands over a short-lived
// ticket signed with the site's own Ed25519 key, checked here with the public half from
// PLAY_SITE/api/play/pubkey (no shared secret to set), and /?ticket=<ticket> turns it into a signed
// player cookie. Such a host has one lobby or game at a time (key holders have no limit).
// PLAY_SITE=off turns Discord hosts off.
const http = require("http");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const MASTER = 3000;
const WORKER_BASE = 3001;
const NUM_WORKERS = Number(process.env.NUM_WORKERS || 1);
const ACCESS_KEY = process.env.ACCESS_KEY || "";
const PLAY_SITE = String(process.env.PLAY_SITE || "https://teamstats.pro")
  .trim()
  .replace(/\/+$/, "");
const COOKIE = "tsp_host";
const USER_COOKIE = "tsp_user";
const USER_COOKIE_MS = 30 * 24 * 3600 * 1000;
const cookieValue = ACCESS_KEY
  ? crypto
      .createHash("sha256")
      .update("tsp-host:" + ACCESS_KEY)
      .digest("hex")
      .slice(0, 32)
  : "";
const ticketsOn = PLAY_SITE !== "" && PLAY_SITE !== "off";
// Signs the player cookie: stable across restarts when ACCESS_KEY is set, otherwise new per start
// (hosts then just open /play again).
const COOKIE_KEY = ACCESS_KEY
  ? crypto
      .createHash("sha256")
      .update("tsp-user:" + ACCESS_KEY)
      .digest()
  : crypto.randomBytes(32);

// The site's public ticket key, fetched on demand and kept for 10 minutes.
let siteKey = { key: null, at: 0 };
async function sitePublicKey(force) {
  const age = Date.now() - siteKey.at;
  if (siteKey.key && age < (force ? 60 * 1000 : 10 * 60 * 1000))
    return siteKey.key;
  try {
    const r = await fetch(`${PLAY_SITE}/api/play/pubkey`, {
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok)
      siteKey = { key: crypto.createPublicKey(await r.text()), at: Date.now() };
  } catch (e) {
    console.error("Cannot fetch the site's ticket key:", e.message);
  }
  return siteKey.key;
}

function route(url) {
  const m = /^\/w(\d+)(\/.*)?$/.exec(url.split("?")[0]);
  if (m) {
    const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    return { port: WORKER_BASE + Number(m[1]), path: (m[2] || "/") + q };
  }
  if (/^\/api\/create_game(\?|$)/.test(url))
    return {
      port: WORKER_BASE + Math.floor(Math.random() * NUM_WORKERS),
      path: url,
    };
  return { port: MASTER, path: url };
}

function cookies(req) {
  const out = {};
  for (const c of (req.headers.cookie || "").split(/;\s*/)) {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i)] = c.slice(i + 1);
  }
  return out;
}
const sign = (s) =>
  crypto.createHmac("sha256", COOKIE_KEY).update(s).digest("base64url");
const sameSig = (a, b) =>
  a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Signed value: base64url(JSON) + "." + HMAC(prefix + body). Returns the JSON when the signature fits and exp is ahead.
function readSigned(v, prefix) {
  if (!v) return null;
  const [body, sig] = String(v).split(".");
  if (!body || !sig || !sameSig(sig, sign(prefix + body))) return null;
  try {
    const d = JSON.parse(Buffer.from(body, "base64url").toString());
    return d && d.id && d.exp > Date.now() ? d : null;
  } catch {
    return null;
  }
}
// Ticket from the site's /play: base64url(JSON {id, name, aud, exp}) + "." + Ed25519 signature of the body.
async function readTicket(t) {
  if (!ticketsOn || !t) return null;
  const [body, sig] = String(t).split(".");
  if (!body || !sig) return null;
  let d;
  try {
    d = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }
  if (!d || !d.id || d.aud !== "teamstats-game" || !(d.exp > Date.now()))
    return null;
  for (const force of [false, true]) {
    const key = await sitePublicKey(force);
    if (!key) return null;
    try {
      if (
        crypto.verify(
          null,
          Buffer.from(body),
          key,
          Buffer.from(sig, "base64url"),
        )
      )
        return d;
    } catch {
      return null;
    }
  }
  return null;
}
// Discord id of a host who came with a ticket (the player cookie), or "".
const userId = (req) =>
  String(readSigned(cookies(req)[USER_COOKIE], "u:")?.id || "");
function userCookie(id) {
  const body = Buffer.from(
    JSON.stringify({ id, exp: Date.now() + USER_COOKIE_MS }),
  ).toString("base64url");
  return `${USER_COOKIE}=${body}.${sign("u:" + body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${USER_COOKIE_MS / 1000}`;
}
const hasKey = (req) => !!ACCESS_KEY && cookies(req)[COOKIE] === cookieValue;
function hasAccess(req) {
  if (!ACCESS_KEY && !ticketsOn) return true;
  return hasKey(req) || !!userId(req);
}
// The host panel (the page itself at "/") needs the key; join links, the game's files and the
// game sockets are open, so invited players get in with just the link.
function isHostOnly(req) {
  const p = req.url.split("?")[0];
  // /streamer-mode is the host's address bar in streamer mode (code hidden):
  // a guest who got it pastes the real invite link instead
  if (p === "/" || p === "/index.html" || p === "/streamer-mode") return true;
  return /^\/api\/create_game$/.test(p) || /^\/w\d+\/api\/create_game/.test(p);
}

// Readable hint for the page (not a secret, the real check is the cookies above): this browser
// is a host, so the home page shows Create Lobby. Guests who end up on the home page only see Join.
const HOST_UI_COOKIE = "tsp_host_ui=1; Path=/; SameSite=Lax; Max-Age=31536000";

// One open lobby or running game per ticket host: their last game id and its worker port.
const lastGame = new Map();
function gameExists(g) {
  return new Promise((resolve) => {
    const r = http.get(
      {
        host: "127.0.0.1",
        port: g.port,
        path: `/api/game/${g.id}/exists`,
        timeout: 1500,
      },
      (res) => {
        let b = "";
        res.on("data", (c) => {
          b += c;
        });
        res.on("end", () => {
          try {
            resolve(!!JSON.parse(b).exists);
          } catch {
            resolve(false);
          }
        });
      },
    );
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve(false));
  });
}

// Shown on "/" without the host key: players paste their invite link or code.
const INVITE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamStats.Pro</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px Inter,system-ui,sans-serif;color:#edf2f7;
background:radial-gradient(circle at 15% -10%,rgba(87,230,255,.10),transparent 40%),radial-gradient(circle at 88% 8%,rgba(176,108,255,.12),transparent 42%),radial-gradient(circle at 50% -10%,#172238 0,#05060a 52%)}
.c{width:min(92vw,440px);padding:28px;border-radius:20px;background:linear-gradient(180deg,rgba(18,26,38,.92),rgba(9,12,18,.95));border:1px solid rgba(110,168,255,.25);box-shadow:0 24px 80px rgba(0,0,0,.5)}
h1{margin:0 0 6px;font-size:26px;letter-spacing:.04em}h1 b{color:#57e6ff}p{margin:0 0 18px;color:#8f9bab;font-size:14px;line-height:1.5}
form{display:flex;gap:8px}input{flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid #232c3c;background:#05060a;color:#fff;font-size:15px}
input:focus{outline:none;border-color:#57e6ff}button{padding:12px 16px;border:0;border-radius:10px;background:#3d7dff;color:#fff;font-weight:700;cursor:pointer}
.e{color:#ff5d6c;font-size:13px;margin-top:10px;min-height:1em}
.host{display:block;margin:18px 0 0;padding:12px;border-radius:10px;border:1px solid rgba(87,230,255,.35);background:rgba(87,230,255,.08);color:#57e6ff;font-weight:700;text-align:center;text-decoration:none}
.host:hover{background:rgba(87,230,255,.16)}</style></head><body><div class="c">
<h1>TEAMSTATS<b>.PRO</b></h1><p>Paste the invite link (or the lobby code) you got from the host. A link ending in <b>/streamer-mode</b> has no code: ask the host to use <b>Copy invite link</b>.</p>
<form id="f"><input id="i" placeholder="https://…/game/AbCd1234 or AbCd1234" autofocus><button>Join</button></form><div class="e" id="e"></div>
${ticketsOn ? `<a class="host" href="${PLAY_SITE}/play">Host your own lobby: log in with Discord</a>` : ""}
<p style="margin:18px 0 0;font-size:12px">© OpenFront and Contributors · <a href="https://github.com/Bembe-tech/teamstats-game" style="color:#6ea8ff">Source code (AGPL-3.0)</a></p></div>
<script>document.getElementById("f").onsubmit=function(ev){ev.preventDefault();var v=document.getElementById("i").value.trim();
var m=/(?:game[/])?([A-Za-z0-9]{8,12})(?:[?#/].*)?$/.exec(v);if(!m){document.getElementById("e").textContent="That does not look like a lobby link or code.";return;}
location.href="/game/"+m[1];};</script></body></html>`;

// Passes the request on; with onDone the answer is buffered and handed over before it is sent.
function proxy(req, res, t, onDone) {
  const up = http.request(
    {
      host: "127.0.0.1",
      port: t.port,
      path: t.path,
      method: req.method,
      headers: req.headers,
    },
    (r) => {
      if (!onDone) {
        res.writeHead(r.statusCode, r.headers);
        return r.pipe(res);
      }
      const parts = [];
      r.on("data", (c) => parts.push(c));
      r.on("end", () => {
        const body = Buffer.concat(parts);
        onDone(r.statusCode, body);
        res.writeHead(r.statusCode, r.headers);
        res.end(body);
      });
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  if (
    ACCESS_KEY &&
    u.pathname === "/" &&
    u.searchParams.get("key") === ACCESS_KEY
  ) {
    res.writeHead(302, {
      "Set-Cookie": [
        `${COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        HOST_UI_COOKIE,
      ],
      Location: "/",
    });
    return res.end();
  }
  // "Host a lobby" on the home page for browsers that are not hosts yet
  if (u.pathname === "/host") {
    if (hasAccess(req)) {
      res.writeHead(302, { "Set-Cookie": HOST_UI_COOKIE, Location: "/" });
      return res.end();
    }
    if (ticketsOn) {
      res.writeHead(302, { Location: `${PLAY_SITE}/play` });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      INVITE_PAGE.replace(
        "Paste the invite link",
        "Hosting needs the host link (it ends with <b>?key=…</b>). Got an invite instead? Paste the invite link",
      ),
    );
  }
  if (u.pathname === "/" && u.searchParams.has("ticket")) {
    const who = await readTicket(u.searchParams.get("ticket"));
    if (who)
      console.log(
        new Date().toISOString(),
        "host login",
        who.id,
        who.name || "",
      );
    res.writeHead(
      302,
      who
        ? {
            "Set-Cookie": [userCookie(String(who.id)), HOST_UI_COOKIE],
            Location: "/",
          }
        : { Location: "/" },
    );
    return res.end();
  }
  // Hosts from before the hint cookie existed: give it once
  if (
    u.pathname === "/" &&
    hasAccess(req) &&
    cookies(req).tsp_host_ui !== "1"
  ) {
    res.writeHead(302, { "Set-Cookie": HOST_UI_COOKIE, Location: req.url });
    return res.end();
  }
  if (isHostOnly(req) && !hasAccess(req)) {
    if (/create_game/.test(req.url))
      console.log(
        new Date().toISOString(),
        "create_game refused: no host key or Discord login",
        req.socket.remoteAddress,
      );
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INVITE_PAGE);
  }
  if (/^\/(w\d+\/)?game\//.test(req.url))
    console.log(new Date().toISOString(), req.socket.remoteAddress, req.url);
  const t = route(req.url);
  const uid =
    req.method === "POST" &&
    /^\/(w\d+\/)?api\/create_game$/.test(u.pathname) &&
    !hasKey(req)
      ? userId(req)
      : "";
  if (!uid) return proxy(req, res, t);
  // A successor of a finished game (?previous=) takes its place, so it is never blocked.
  const prev = lastGame.get(uid);
  if (prev && !u.searchParams.has("previous") && (await gameExists(prev))) {
    res.writeHead(429, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error:
          "You already have an open lobby or game. Close it before you create another one.",
        gameID: prev.id,
      }),
    );
  }
  proxy(req, res, t, (status, body) => {
    if (status !== 200) return;
    try {
      const g = JSON.parse(body.toString());
      if (g.gameID) lastGame.set(uid, { id: g.gameID, port: t.port });
    } catch {}
  });
});

server.on("upgrade", (req, socket, head) => {
  const t = route(req.url);
  const up = net.connect(t.port, "127.0.0.1", () => {
    let raw = `${req.method} ${t.path} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, () =>
  console.log(
    `TeamStats.Pro front on :${PORT} (master ${MASTER}, ${NUM_WORKERS} worker(s)${ticketsOn ? ", Discord hosts on" : ""})`,
  ),
);
