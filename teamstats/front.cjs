// TeamStats.Pro game: one public port in front of OpenFront's master (3000) and worker (3001),
// doing what nginx.conf does on OpenFront's own servers: /wN/... goes to worker N (path without
// the /wN prefix), /api/create_game to a worker, everything else to the master. WebSockets too.
// Also the gate: without the access cookie or a Discord login nobody can create a lobby (guests get the
// home page, join links and public lobbies); /?key=<ACCESS_KEY> sets the cookie and opens the host panel.
// Everyone logged in with Discord on teamstats.pro may host too: the site's /play hands over a short-lived
// ticket signed with the site's own Ed25519 key, checked here with the public half from
// PLAY_SITE/api/play/pubkey (no shared secret to set), and /?ticket=<ticket> turns it into a signed
// player cookie. Such a host has one lobby or game at a time (key holders have no limit).
// PLAY_SITE=off turns Discord hosts off.
// Site identity (Bembe 2026-11-15): the ticket also carries the player's name, clan tag and avatar from their
// teamstats.pro account; the player cookie keeps them, /api/tsp/me hands them to the page (UsernameInput fills
// the name and tag fields from it) and game sockets get an x-tsp-user header with the Discord id, so the
// worker knows which player is which site account. Finished games come back from the worker to
// /internal/game-result (loopback + API_KEY only), are signed here with a key made at start (public half at
// /api/tsp/pubkey) and POSTed to PLAY_SITE/api/play/game-result, which stores them on the player's profile.
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = Number(process.env.PORT || 8080);
const MASTER = 3000;
const WORKER_BASE = 3001;
const NUM_WORKERS = Number(process.env.NUM_WORKERS || 1);
const ACCESS_KEY = process.env.ACCESS_KEY || "";
const PLAY_SITE = String(process.env.PLAY_SITE || "https://teamstats.pro")
  .trim()
  .replace(/\/+$/, "");
// The site lets this User-Agent through its bot blocker for the game endpoints (JR-WEBPAGE bots.js).
const GAME_UA = "TeamStatsPro-Game/1.0 (+https://teamstats.pro/play)";
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
// The site's admin Traffic card (tab "TeamStats Game"): the page beats there from the player's browser
// (src/client/TspBeat.ts), finished games are reported by this front (/internal/game-record).
const BEAT_URL = ticketsOn ? `${PLAY_SITE}/api/play/beat?p=tsgame` : null;
// Bembe 2026-11-18: the game is open to everyone, a Discord login is not needed to play or to host.
// Guests are limited per IP (one open lobby, LOBBIES_PER_HOUR); GUEST_HOSTS=off brings the old
// rule back (only key holders and Discord logins create lobbies, guests only join).
const guestHosts = String(process.env.GUEST_HOSTS || "on").trim() !== "off";
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
      headers: { "User-Agent": GAME_UA },
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
const siteUser = (req) => readSigned(cookies(req)[USER_COOKIE], "u:");
const userId = (req) => String(siteUser(req)?.id || "");
const short = (v, n) => String(v ?? "").slice(0, n);
function userCookie(who) {
  const body = Buffer.from(
    JSON.stringify({
      id: String(who.id),
      name: short(who.name, 20),
      tag: /^[A-Za-z0-9]{2,5}$/.test(String(who.tag || "")) ? who.tag : "",
      avatar: /^https:\/\/cdn\.discordapp\.com\//.test(String(who.avatar || ""))
        ? short(who.avatar, 200)
        : "",
      exp: Date.now() + USER_COOKIE_MS,
    }),
  ).toString("base64url");
  return `${USER_COOKIE}=${body}.${sign("u:" + body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${USER_COOKIE_MS / 1000}`;
}
const hasKey = (req) => !!ACCESS_KEY && cookies(req)[COOKIE] === cookieValue;
function hasAccess(req) {
  if (guestHosts || (!ACCESS_KEY && !ticketsOn)) return true;
  return hasKey(req) || !!userId(req);
}
// Who owns a lobby for the limits: the Discord id, or "guest:<ip>" for a guest.
const hostId = (req) =>
  userId(req) || (guestHosts ? "guest:" + clientIp(req) : "");
// Making a lobby needs the key or a Discord login. The home page itself is open (Bembe 2026-11-18:
// guests without Discord could not get into the game at all): guests see Join, the public lobbies
// and "Host a lobby" (-> log in), but no Create Lobby (GameModeSelector.ts reads tsp_host_ui).
// Join links, the game's files and the game sockets are open too.
function isHostOnly(req) {
  const p = req.url.split("?")[0];
  // /streamer-mode is the host's address bar in streamer mode (code hidden):
  // a guest who got it pastes the real invite link instead
  if (p === "/streamer-mode") return true;
  return /^\/api\/create_game$/.test(p) || /^\/w\d+\/api\/create_game/.test(p);
}

// Readable hint for the page (not a secret, the real check is the cookies above): this browser
// is a host, so the home page shows Create Lobby. Guests who end up on the home page only see Join.
const HOST_UI_COOKIE = "tsp_host_ui=1; Path=/; SameSite=Lax; Max-Age=31536000";

// One open lobby or running game per ticket host: their last game id and its worker port.
const lastGame = new Map();
// Against abuse (Bembe 2026-11-15: every Discord login may host, guests only join): at most
// MAX_DISCORD_LOBBIES open lobbies/games of Discord hosts at once (server resources), and at most
// LOBBIES_PER_HOUR new lobbies per account and per IP in an hour. Key holders are not limited.
const MAX_DISCORD_LOBBIES = Number(process.env.MAX_DISCORD_LOBBIES || 25);
const LOBBIES_PER_HOUR = Number(process.env.LOBBIES_PER_HOUR || 12);
const recentCreates = new Map(); // account id or "ip:<addr>" -> times of new lobbies in the last hour
function tooManyCreates(keys) {
  const cutoff = Date.now() - 3600 * 1000;
  for (const k of keys) {
    const list = (recentCreates.get(k) || []).filter((t) => t > cutoff);
    recentCreates.set(k, list);
    if (list.length >= LOBBIES_PER_HOUR) return true;
  }
  return false;
}
function noteCreate(keys) {
  for (const k of keys) recentCreates.get(k)?.push(Date.now());
  if (recentCreates.size > 5000)
    for (const [k, v] of recentCreates) if (!v.length) recentCreates.delete(k);
}
async function openDiscordLobbies(exceptUid) {
  let n = 0;
  for (const [id, g] of lastGame) {
    if (id === exceptUid) continue;
    if (await gameExists(g)) n++;
    else lastGame.delete(id);
  }
  return n;
}
const clientIp = (req) =>
  String(
    req.headers["cf-connecting-ip"] ||
      String(req.headers["x-forwarded-for"] || "").split(",")[0] ||
      req.socket.remoteAddress ||
      "",
  ).trim();
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
            const j = JSON.parse(b);
            // "open" (newer workers): finished, won or host-left games free the slot
            resolve(!!j.exists && j.open !== false);
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

// Public lobbies (Bembe 2026-11-16): a host logged in with Discord (or with the key) flips "Public game"
// in the lobby (HostLobbyModal.ts) and the lobby shows on the home page (TspPublicLobbies.ts) until it
// starts or closes. One public lobby per account; MAX_PUBLIC_LOBBIES in all.
const MAX_PUBLIC_LOBBIES = Number(process.env.MAX_PUBLIC_LOBBIES || 30);
const publicLobbies = new Map(); // gameID -> { gameID, port, owner, host, avatar, at }
function getJsonLocal(port, path) {
  return new Promise((resolve) => {
    const r = http.get(
      { host: "127.0.0.1", port, path, timeout: 1500 },
      (res) => {
        let b = "";
        res.on("data", (c) => {
          if (b.length < 200000) b += c;
        });
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(b) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve(null));
  });
}
async function findGamePort(gameID) {
  for (let i = 0; i < NUM_WORKERS; i++) {
    const e = await getJsonLocal(WORKER_BASE + i, `/api/game/${gameID}/exists`);
    if (e && e.exists) return WORKER_BASE + i;
  }
  return 0;
}
let publicCache = { at: 0, list: [] };
async function publicLobbyList() {
  if (Date.now() - publicCache.at < 4000) return publicCache.list;
  const list = [];
  for (const [id, l] of publicLobbies) {
    const e = await getJsonLocal(l.port, `/api/game/${id}/exists`);
    // gone, finished, started or left by its host: off the list
    if (
      !e ||
      !e.exists ||
      e.open === false ||
      e.started ||
      Date.now() - l.at > 3 * 3600 * 1000
    ) {
      publicLobbies.delete(id);
      continue;
    }
    const info = await getJsonLocal(l.port, `/api/game/${id}`);
    if (!info) continue;
    const cfg = info.gameConfig || {};
    const players = (info.clients || []).filter((c) => !c.spectator).length;
    list.push({
      gameID: id,
      host: l.host,
      avatar: l.avatar,
      map: String(cfg.gameMap || ""),
      mode: String(cfg.gameMode || ""),
      teams: cfg.playerTeams == null ? null : String(cfg.playerTeams),
      fog: cfg.fogOfWar === true,
      players,
      maxPlayers: Number(cfg.maxPlayers) || null,
      since: l.at,
    });
  }
  publicCache = { at: Date.now(), list };
  return list;
}

// Signs finished games for the site (new key per start; the site fetches /api/tsp/pubkey).
const resultKeys = crypto.generateKeyPairSync("ed25519");
const RESULT_PUB = resultKeys.publicKey.export({ type: "spki", format: "pem" });
const INTERNAL_KEY = process.env.API_KEY || "";
const resultQueue = []; // games the site has not taken yet, retried with a growing wait
let sending = false;
async function sendResults() {
  if (sending) return;
  sending = true;
  while (resultQueue.length) {
    const item = resultQueue[0];
    if (item.next > Date.now()) {
      setTimeout(sendResults, item.next - Date.now());
      break;
    }
    const body = Buffer.from(JSON.stringify(item.game)).toString("base64url");
    const sig = crypto
      .sign(null, Buffer.from(body), resultKeys.privateKey)
      .toString("base64url");
    let ok = false;
    try {
      const r = await fetch(`${PLAY_SITE}/api/play/game-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": GAME_UA },
        body: JSON.stringify({ body, sig }),
        signal: AbortSignal.timeout(10000),
      });
      // 4xx other than a bad signature will not get better with a retry
      ok = r.ok || (r.status >= 400 && r.status < 500 && r.status !== 403);
      console.log(
        new Date().toISOString(),
        "game result",
        item.game.gameID,
        "->",
        r.status,
      );
    } catch (e) {
      console.error("Cannot send game result:", e.message);
    }
    if (ok || ++item.tries >= 8) resultQueue.shift();
    else item.next = Date.now() + Math.min(30 * 60000, 15000 * 2 ** item.tries);
  }
  sending = false;
}
// The Skin Gallery's public patterns (no private skin is ever listed by the site), kept 10 minutes.
// SKIN_GALLERY_SITE (default PLAY_SITE) is where they come from; src/server/SiteLink.ts reads the same.
const GALLERY_SITE = String(process.env.SKIN_GALLERY_SITE || PLAY_SITE)
  .trim()
  .replace(/\/+$/, "");
let galleryCache = { at: 0, items: [] };
async function gallerySkins() {
  if (Date.now() - galleryCache.at < 10 * 60 * 1000) return galleryCache.items;
  if (GALLERY_SITE === "off" || !GALLERY_SITE) return [];
  try {
    const r = await fetch(`${GALLERY_SITE}/api/skins`, {
      headers: { "User-Agent": GAME_UA },
      signal: AbortSignal.timeout(6000),
    });
    const d = r.ok ? await r.json() : { items: [] };
    const items = (d.items || [])
      .filter(
        (s) =>
          !s.private &&
          typeof s.code === "string" &&
          /^[A-Za-z0-9_-]{4,20}$/.test(String(s.id)),
      )
      .map((s) => ({
        id: s.id,
        pattern:
          "tsp_" + Buffer.from(s.id, "base64url").toString("hex").slice(0, 28),
        name: short(s.name || "Skin", 60),
        code: s.code,
        primary: /^#[0-9a-f]{6}$/i.test(s.primary) ? s.primary : "#ffffff",
        secondary: /^#[0-9a-f]{6}$/i.test(s.secondary)
          ? s.secondary
          : "#000000",
        owner: short(s.owner?.name || "", 40),
        rating: Number(s.rating) || 0,
        created: short(s.createdAt || "", 30),
      }))
      .sort((a, b) => b.rating - a.rating);
    galleryCache = { at: Date.now(), items };
  } catch (e) {
    console.error("Cannot load the skin gallery:", e.message);
    galleryCache.at = Date.now() - 9 * 60 * 1000;
  }
  return galleryCache.items;
}
// Finished games, whole (turns too), for "Last games" and replays (Bembe 2026-11-18). The workers hand
// each record to /internal/game-record; it is kept gzipped as <dir>/<gameID>.json.gz and listed in
// <dir>/index.json (newest first, MAX_GAME_RECORDS kept, the oldest files are deleted). On Railway the
// directory must be on a volume (mount it at /data), or the games are gone after every deploy.
// GAME_RECORDS_DIR=off turns it off.
const RECORDS_DIR = (() => {
  const v = String(process.env.GAME_RECORDS_DIR || "").trim();
  if (v === "off") return "";
  if (v) return v;
  return fs.existsSync("/data")
    ? "/data/game-records"
    : path.join(__dirname, "..", "data", "game-records");
})();
const MAX_GAME_RECORDS = Number(process.env.MAX_GAME_RECORDS || 3000);
let recordIndex = [];
if (RECORDS_DIR) {
  try {
    fs.mkdirSync(RECORDS_DIR, { recursive: true });
    recordIndex = JSON.parse(
      fs.readFileSync(path.join(RECORDS_DIR, "index.json"), "utf8"),
    );
    if (!Array.isArray(recordIndex)) recordIndex = [];
  } catch {
    recordIndex = [];
  }
  console.log(
    `Game records in ${RECORDS_DIR} (${recordIndex.length} kept, max ${MAX_GAME_RECORDS})`,
  );
}
const recordFile = (id) => path.join(RECORDS_DIR, `${id}.json.gz`);
let indexWrite = Promise.resolve();
function saveIndex() {
  const data = JSON.stringify(recordIndex);
  indexWrite = indexWrite.then(async () => {
    const f = path.join(RECORDS_DIR, "index.json");
    try {
      await fs.promises.writeFile(f + ".tmp", data);
      await fs.promises.rename(f + ".tmp", f);
    } catch (e) {
      console.error("Cannot save the game index:", e.message);
    }
  });
}
// What "Last games" shows of one game (no ids of accounts, no persistent ids).
function recordSummary(rec) {
  const info = rec.info || {};
  const cfg = info.config || {};
  const players = (info.players || []).map((p) => ({
    id: String(p.clientID || ""),
    name: short(p.username, 30),
    tag: p.clanTag ? short(p.clanTag, 5) : "",
  }));
  const w = Array.isArray(info.winner) ? info.winner : null;
  const winIds = new Set(
    w ? w.slice(w[0] === "player" ? 1 : 2).map(String) : [],
  );
  return {
    gameID: String(info.gameID),
    commit: short(rec.gitCommit, 40),
    map: short(cfg.gameMap, 40),
    mode: short(cfg.gameMode, 20),
    teams: cfg.playerTeams == null ? null : short(cfg.playerTeams, 20),
    fog: cfg.fogOfWar === true,
    start: Number(info.start) || 0,
    end: Number(info.end) || Date.now(),
    duration: Number(info.duration) || 0,
    winnerTeam: w && w[0] !== "player" ? short(w[1], 30) : null,
    winners: players.filter((p) => winIds.has(p.id)).map((p) => p.name),
    players: players.map((p) => (p.tag ? `[${p.tag}] ${p.name}` : p.name)),
  };
}
async function storeRecord(rec) {
  const id = String(rec?.info?.gameID || "");
  if (!RECORDS_DIR || !/^[A-Za-z0-9]{4,16}$/.test(id)) return false;
  // persistent ids are private (OpenFront's API scrubs them too)
  for (const p of rec.info.players || []) if (p) p.persistentID = null;
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(rec)));
  await fs.promises.writeFile(recordFile(id), gz);
  recordIndex = recordIndex.filter((g) => g.gameID !== id);
  recordIndex.unshift(recordSummary(rec));
  for (const old of recordIndex.splice(MAX_GAME_RECORDS))
    fs.promises.unlink(recordFile(old.gameID)).catch(() => {});
  saveIndex();
  console.log(
    new Date().toISOString(),
    "game record",
    id,
    Math.round(gz.length / 1024) + " KB",
  );
  return true;
}

// A signed request to the site ({ body: base64url(JSON), sig }), checked there with /api/tsp/pubkey.
async function siteCall(path, payload) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, sentAt: Date.now() }),
  ).toString("base64url");
  const sig = crypto
    .sign(null, Buffer.from(body), resultKeys.privateKey)
    .toString("base64url");
  try {
    const r = await fetch(`${PLAY_SITE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": GAME_UA },
      body: JSON.stringify({ body, sig }),
      signal: AbortSignal.timeout(8000),
    });
    let j = null;
    try {
      j = await r.json();
    } catch {}
    return { status: r.status, body: j || { error: "site error" } };
  } catch (e) {
    return { status: 502, body: { error: "site unreachable: " + e.message } };
  }
}
function readJson(req, max) {
  return new Promise((resolve) => {
    // chunks joined as bytes, so a character split between two chunks stays whole
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      parts.push(c);
      size += c.length;
      if (size > max) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
const isLoopback = (req) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    String(req.socket.remoteAddress || ""),
  );
const sendJson = (res, code, v) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(v));
};
// Only an invite link of this game or the home page, so a login never bounces the player elsewhere.
const safeNext = (n) =>
  /^\/game\/[A-Za-z0-9]{4,16}$/.test(String(n || "")) ? n : "/";

// Shown to guests on host-only addresses (/streamer-mode, /host without tickets): paste the invite link or code.
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
    const who = u.searchParams.has("ticket")
      ? await readTicket(u.searchParams.get("ticket"))
      : null;
    res.writeHead(302, {
      "Set-Cookie": [
        `${COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        HOST_UI_COOKIE,
        ...(who ? [userCookie(who)] : []),
      ],
      Location: safeNext(u.searchParams.get("next")),
    });
    return res.end();
  }
  // Who this browser is on teamstats.pro (from the player cookie), for the name / tag fields.
  if (u.pathname === "/api/tsp/me") {
    const me = siteUser(req);
    return sendJson(
      res,
      200,
      me
        ? {
            loggedIn: true,
            id: String(me.id),
            name: me.name || "",
            tag: me.tag || "",
            avatar: me.avatar || "",
            profile: `${PLAY_SITE}/play-profile.html?u=${encodeURIComponent(me.id)}`,
            site: GALLERY_SITE,
            beat: BEAT_URL,
          }
        : {
            loggedIn: false,
            login: ticketsOn ? "/login" : null,
            site: GALLERY_SITE,
            beat: BEAT_URL,
            beat: BEAT_URL,
          },
    );
  }
  if (u.pathname === "/api/tsp/pubkey") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(RESULT_PUB);
  }
  // Log in with teamstats.pro: the site's /play logs in with Discord and comes back with a ticket.
  if (u.pathname === "/login" && ticketsOn) {
    const next = safeNext(u.searchParams.get("next"));
    res.writeHead(302, {
      Location: `${PLAY_SITE}/play${next !== "/" ? "?next=" + encodeURIComponent(next) : ""}`,
    });
    return res.end();
  }
  if (u.pathname === "/logout") {
    res.writeHead(302, {
      "Set-Cookie": `${USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      Location: "/",
    });
    return res.end();
  }
  // Public patterns of the teamstats.pro Skin Gallery for the picker in "Your Profile" (TspPattern.ts).
  if (u.pathname === "/api/tsp/skins" && req.method === "GET") {
    return sendJson(res, 200, { items: await gallerySkins() });
  }
  // The home page's list of public lobbies (polled every few seconds by TspPublicLobbies.ts).
  if (u.pathname === "/api/tsp/public-lobbies" && req.method === "GET") {
    return sendJson(res, 200, { lobbies: await publicLobbyList() });
  }
  // "Public game" switch of a host: { gameID, public }.
  if (u.pathname === "/api/tsp/public" && req.method === "POST") {
    const me = siteUser(req);
    const uid = hostId(req);
    const key = hasKey(req);
    if (!uid && !key)
      return sendJson(res, 401, {
        error: "Log in with Discord to make a lobby public.",
      });
    const b = await readJson(req, 2000);
    const gameID = String(b?.gameID || "");
    if (!/^[A-Za-z0-9]{4,16}$/.test(gameID))
      return sendJson(res, 400, { error: "bad lobby" });
    const mine = key || lastGame.get(uid)?.id === gameID;
    if (!mine)
      return sendJson(res, 403, {
        error: "Only the host of this lobby can do that.",
      });
    if (!b.public) {
      publicLobbies.delete(gameID);
      publicCache.at = 0;
      return sendJson(res, 200, { public: false });
    }
    const port = lastGame.get(uid)?.port || (await findGamePort(gameID));
    const e = port
      ? await getJsonLocal(port, `/api/game/${gameID}/exists`)
      : null;
    if (!e || !e.exists || e.started)
      return sendJson(res, 409, {
        error: "This lobby has already started or closed.",
      });
    // one public lobby per account: an older one of the same host leaves the list
    for (const [id, l] of publicLobbies)
      if (id !== gameID && l.owner === (uid || "key")) publicLobbies.delete(id);
    if (!publicLobbies.has(gameID) && publicLobbies.size >= MAX_PUBLIC_LOBBIES)
      return sendJson(res, 503, {
        error:
          "The public list is full right now. Share the invite link instead.",
      });
    publicLobbies.set(gameID, {
      gameID,
      port,
      owner: uid || "key",
      host: short(
        me?.name || (uid.startsWith("guest:") ? "Guest" : "Host"),
        20,
      ),
      avatar: me?.avatar || "",
      at: publicLobbies.get(gameID)?.at || Date.now(),
    });
    publicCache.at = 0;
    console.log(new Date().toISOString(), "public lobby", gameID, uid || "key");
    return sendJson(res, 200, { public: true });
  }
  // Game settings of a logged-in player, kept on their teamstats.pro account (src/client/TspProfile.ts).
  // The page talks to this front only; the front asks the site with a signed request naming the account
  // from the signed cookie, so nobody can read or change another account's settings.
  if (u.pathname === "/api/tsp/settings") {
    const uid = userId(req);
    if (!uid || !ticketsOn)
      return sendJson(res, 401, { error: "not logged in" });
    if (req.method !== "GET" && req.method !== "PUT")
      return sendJson(res, 405, { error: "GET or PUT" });
    const put = req.method === "PUT" ? await readJson(req, 220 * 1024) : null;
    if (req.method === "PUT" && (!put || typeof put.settings !== "object"))
      return sendJson(res, 400, { error: "bad settings" });
    const r = await siteCall("/api/play/settings", {
      op: put ? "put" : "get",
      user: uid,
      ...(put ? { settings: put.settings } : {}),
    });
    return sendJson(res, r.status, r.body);
  }
  // The whole finished game from a worker (Archive.ts sendRecordToFront), kept on disk.
  if (u.pathname === "/internal/game-record" && req.method === "POST") {
    if (
      !isLoopback(req) ||
      req.headers["x-forwarded-for"] ||
      !INTERNAL_KEY ||
      req.headers["x-tsp-internal"] !== INTERNAL_KEY
    )
      return sendJson(res, 403, { error: "forbidden" });
    const rec = await readJson(req, 64 * 1024 * 1024);
    if (!rec || !rec.info || !rec.info.gameID)
      return sendJson(res, 400, { error: "bad record" });
    if (ticketsOn)
      siteCall("/api/play/game-stat", {
        gameID: String(rec.info.gameID),
        players: (rec.info.players || []).length,
      }).then((r) => {
        if (r.status !== 200)
          console.error("Traffic game stat refused:", r.status, r.body?.error);
      });
    try {
      return sendJson(res, 200, { ok: await storeRecord(rec) });
    } catch (e) {
      console.error("Cannot store game record:", e.message);
      return sendJson(res, 500, { error: "cannot store" });
    }
  }
  // "Last games" on the home page (TspLastGames.ts).
  if (u.pathname === "/api/tsp/last-games" && req.method === "GET") {
    const n = Math.min(
      100,
      Math.max(1, Number(u.searchParams.get("limit")) || 20),
    );
    // a replay plays only on the build it was recorded on (JoinLobbyModal.checkArchivedGame)
    const build = String(process.env.GIT_COMMIT || "");
    return sendJson(res, 200, {
      games: recordIndex.slice(0, n).map(({ commit, ...g }) => ({
        ...g,
        replay: build === "DEV" || commit === "DEV" || commit === build,
      })),
    });
  }
  // One finished game, the same JSON OpenFront's archive gives; the game's replay reads it
  // (JoinLobbyModal.checkArchivedGame).
  const recM = /^\/api\/tsp\/game\/([A-Za-z0-9]{4,16})$/.exec(u.pathname);
  if (recM && (req.method === "GET" || req.method === "HEAD")) {
    if (!RECORDS_DIR) return sendJson(res, 404, { error: "not found" });
    let gz;
    try {
      gz = await fs.promises.readFile(recordFile(recM[1]));
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
    const gzipOk = /gzip/.test(String(req.headers["accept-encoding"] || ""));
    const body = gzipOk ? gz : zlib.gunzipSync(gz);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      ...(gzipOk ? { "Content-Encoding": "gzip" } : {}),
      "Content-Length": body.length,
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  // A finished game from a worker (GameServer.archiveGame -> Archive.ts), passed on to the site.
  if (u.pathname === "/internal/game-result" && req.method === "POST") {
    if (
      !isLoopback(req) ||
      req.headers["x-forwarded-for"] ||
      !INTERNAL_KEY ||
      req.headers["x-tsp-internal"] !== INTERNAL_KEY
    )
      return sendJson(res, 403, { error: "forbidden" });
    const game = await readJson(req, 300000);
    if (!game || !game.gameID) return sendJson(res, 400, { error: "bad game" });
    if (ticketsOn && (game.players || []).some((p) => p.siteUser)) {
      game.sentAt = Date.now();
      resultQueue.push({ game, tries: 0, next: 0 });
      if (resultQueue.length > 500) resultQueue.shift();
      sendResults();
    }
    return sendJson(res, 200, { ok: true });
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
            "Set-Cookie": [userCookie(who), HOST_UI_COOKIE],
            Location: safeNext(u.searchParams.get("next")),
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
  // A guest whose login ran out still has the hint cookie: take it away, so the page shows
  // "Host a lobby" (log in) instead of a Create Lobby that the server refuses.
  if (
    (u.pathname === "/" || u.pathname === "/index.html") &&
    !hasAccess(req) &&
    cookies(req).tsp_host_ui === "1"
  ) {
    res.writeHead(302, {
      "Set-Cookie": "tsp_host_ui=; Path=/; SameSite=Lax; Max-Age=0",
      Location: req.url,
    });
    return res.end();
  }
  if (isHostOnly(req) && !hasAccess(req)) {
    if (/create_game/.test(u.pathname)) {
      console.log(
        new Date().toISOString(),
        "create_game refused: no host key or Discord login",
        req.socket.remoteAddress,
      );
      return sendJson(res, 403, {
        error: "Log in with Discord to create a lobby.",
        login: ticketsOn ? "/login" : null,
      });
    }
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
      ? hostId(req)
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
  const limitKeys = [uid, "ip:" + clientIp(req)];
  if (!u.searchParams.has("previous") && tooManyCreates(limitKeys)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error: `You made ${LOBBIES_PER_HOUR} lobbies in the last hour. Try again a bit later.`,
      }),
    );
  }
  if (lastGame.size >= MAX_DISCORD_LOBBIES) {
    if ((await openDiscordLobbies(uid)) >= MAX_DISCORD_LOBBIES) {
      console.log(
        new Date().toISOString(),
        "create_game refused: server full",
        uid,
      );
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          error:
            "All lobby slots are in use right now. Join a friend's lobby or try again in a few minutes.",
        }),
      );
    }
  }
  proxy(req, res, t, (status, body) => {
    if (status !== 200) return;
    try {
      const g = JSON.parse(body.toString());
      if (g.gameID) {
        lastGame.set(uid, { id: g.gameID, port: t.port });
        noteCreate(limitKeys);
      }
    } catch {}
  });
});

server.on("upgrade", (req, socket, head) => {
  const t = route(req.url);
  // The site account of this socket for the worker; the header is never taken from the browser.
  const who = siteUser(req);
  const uid = String(who?.id || "");
  const up = net.connect(t.port, "127.0.0.1", () => {
    let raw = `${req.method} ${t.path} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (!/^x-tsp-/i.test(req.rawHeaders[i]))
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    if (/^\d{5,25}$/.test(uid)) {
      raw += `x-tsp-user: ${uid}\r\n`;
      // the Discord avatar shown next to the name (SiteLink.siteAvatar); checked when the cookie was made
      if (who.avatar)
        raw += `x-tsp-avatar: ${String(who.avatar).replace(/[^\x21-\x7e]/g, "")}\r\n`;
    }
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
