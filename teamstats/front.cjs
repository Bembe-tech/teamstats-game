// TeamStats.Pro game: one public port in front of OpenFront's master (3000) and worker (3001),
// doing what nginx.conf does on OpenFront's own servers: /wN/... goes to worker N (path without
// the /wN prefix), /api/create_game to a worker, everything else to the master. WebSockets too.
// Also the gate: without the access cookie only /join/<id> links (and what the game loads) work;
// /?key=<ACCESS_KEY> sets the cookie and opens the host panel.
const http = require("http");
const net = require("net");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const MASTER = 3000;
const WORKER_BASE = 3001;
const NUM_WORKERS = Number(process.env.NUM_WORKERS || 1);
const ACCESS_KEY = process.env.ACCESS_KEY || "";
const COOKIE = "tsp_host";
const cookieValue = ACCESS_KEY ? crypto.createHash("sha256").update("tsp-host:" + ACCESS_KEY).digest("hex").slice(0, 32) : "";

function route(url) {
  const m = /^\/w(\d+)(\/.*)?$/.exec(url.split("?")[0]);
  if (m) {
    const q = url.includes("?") ? url.slice(url.indexOf("?")) : "";
    return { port: WORKER_BASE + Number(m[1]), path: (m[2] || "/") + q };
  }
  if (/^\/api\/create_game(\?|$)/.test(url)) return { port: WORKER_BASE + Math.floor(Math.random() * NUM_WORKERS), path: url };
  return { port: MASTER, path: url };
}

function hasAccess(req) {
  if (!ACCESS_KEY) return true;
  return (req.headers.cookie || "").split(/;\s*/).some(c => c === COOKIE + "=" + cookieValue);
}
// The host panel (the page itself at "/") needs the key; join links, the game's files and the
// game sockets are open, so invited players get in with just the link.
function isHostOnly(req) {
  const p = req.url.split("?")[0];
  if (p === "/" || p === "/index.html") return true;
  return /^\/api\/create_game$/.test(p) || /^\/w\d+\/api\/create_game/.test(p);
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
.e{color:#ff5d6c;font-size:13px;margin-top:10px;min-height:1em}</style></head><body><div class="c">
<h1>TEAMSTATS<b>.PRO</b></h1><p>Paste the invite link (or the lobby code) you got from the host.</p>
<form id="f"><input id="i" placeholder="https://…/game/AbCd1234 or AbCd1234" autofocus><button>Join</button></form><div class="e" id="e"></div>
<p style="margin:18px 0 0;font-size:12px">© OpenFront and Contributors · <a href="https://github.com/Bembe-tech/teamstats-game" style="color:#6ea8ff">Source code (AGPL-3.0)</a></p></div>
<script>document.getElementById("f").onsubmit=function(ev){ev.preventDefault();var v=document.getElementById("i").value.trim();
var m=/(?:game[/])?([A-Za-z0-9]{8,12})(?:[?#/].*)?$/.exec(v);if(!m){document.getElementById("e").textContent="That does not look like a lobby link or code.";return;}
location.href="/game/"+m[1];};</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (ACCESS_KEY && u.pathname === "/" && u.searchParams.get("key") === ACCESS_KEY) {
    res.writeHead(302, { "Set-Cookie": `${COOKIE}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, Location: "/" });
    return res.end();
  }
  if (isHostOnly(req) && !hasAccess(req)) {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INVITE_PAGE);
  }
  if (/^\/(w\d+\/)?game\//.test(req.url)) console.log(new Date().toISOString(), req.socket.remoteAddress, req.url);
  const t = route(req.url);
  const up = http.request({ host: "127.0.0.1", port: t.port, path: t.path, method: req.method, headers: req.headers }, r => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const t = route(req.url);
  const up = net.connect(t.port, "127.0.0.1", () => {
    let raw = `${req.method} ${t.path} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, () => console.log(`TeamStats.Pro front on :${PORT} (master ${MASTER}, ${NUM_WORKERS} worker(s))`));
