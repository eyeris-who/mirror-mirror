/**
 * Who may talk to this server. The API can read personal memory (wifi
 * passwords, door codes…), so two checks run before any route:
 *
 *  - Host header — blocks DNS rebinding, where evil.example re-resolves to
 *    127.0.0.1 and the browser then treats this API as same-origin with the
 *    attacker's page. Only loopback names (plus ALLOWED_HOSTS) pass.
 *  - Origin header — blocks other websites' scripts calling in. cors() alone
 *    only hides the response from the page; the request itself still runs.
 *
 * Server-to-server callers (the voice service) and top-level navigations
 * (OAuth callbacks) send no Origin and are unaffected.
 */

export function hostnameOf(hostHeader = "") {
  const h = String(hostHeader).toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0];
}

export function accessPolicy({ webOrigin, port, allowedHosts = "" }) {
  const extra = String(allowedHosts)
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  const hostnames = new Set(["localhost", "127.0.0.1", "[::1]", ...extra]);
  const origins = new Set([
    webOrigin,
    webOrigin.replace("//localhost", "//127.0.0.1"),
    webOrigin.replace("//127.0.0.1", "//localhost"),
    ...["localhost", "127.0.0.1", ...extra].map((h) => `http://${h}:${port}`),
    ...extra.map((h) => `http://${h}:5173`),
  ]);

  /** null when allowed, else the error code to send with a 403. */
  function check({ host, origin }) {
    if (!hostnames.has(hostnameOf(host))) return "host_not_allowed";
    if (origin && !origins.has(origin)) return "origin_not_allowed";
    return null;
  }

  function middleware(req, res, next) {
    const error = check({ host: req.headers.host, origin: req.headers.origin });
    if (error) return res.status(403).json({ error });
    next();
  }

  return { hostnames, origins: [...origins], check, middleware };
}
