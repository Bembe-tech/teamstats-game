// TeamStats.Pro: the admin Traffic card on teamstats.pro (tab "TeamStats Game", Bembe 2026-11-18) counts
// sessions, players, time played and people online from beats this page sends while it is visible, the
// same beats as the site's own minigames (JR-WEBPAGE traffic.js). The beat address comes from
// teamstats/front.cjs (/api/tsp/me "beat", null when the site link is off). Sent straight from the
// browser (no cookies, no body, no-cors), so the site counts this player and not the game server.
const sid = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
  b.toString(16).padStart(2, "0"),
).join("");
let base: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

const url = (end: boolean) => `${base}&s=${sid}${end ? "&end=1" : ""}`;
function beat() {
  fetch(url(false), {
    method: "POST",
    mode: "no-cors",
    keepalive: true,
    cache: "no-store",
    credentials: "omit",
  }).catch(() => {});
}
function start() {
  if (!base || timer) return;
  beat();
  timer = setInterval(beat, 30000);
}
function stop() {
  if (!base || !timer) return;
  clearInterval(timer);
  timer = undefined;
  if (!navigator.sendBeacon?.(url(true)))
    fetch(url(true), {
      method: "POST",
      mode: "no-cors",
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
}

fetch("/api/tsp/me", { credentials: "same-origin" })
  .then((r) => (r.ok ? r.json() : null))
  .then((me: { beat?: string | null } | null) => {
    if (!me?.beat || !/^https?:\/\/[^\s]+\?p=[a-z0-9]+$/i.test(me.beat)) return;
    base = me.beat;
    document.addEventListener("visibilitychange", () =>
      document.visibilityState === "visible" ? start() : stop(),
    );
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", () => {
      if (document.visibilityState === "visible") start();
    });
    if (document.visibilityState === "visible") start();
  })
  .catch(() => {});

export {};
