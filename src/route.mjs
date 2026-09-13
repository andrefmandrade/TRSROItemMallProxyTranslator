import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PROXIES_FILE } from './paths.mjs';

/**
 * Which SOCKS5 proxy a given mall request belongs to.
 *
 * The mall runs on the client's embedded IE control, which goes through WinINet
 * -- a per-Windows-user setting. So one local proxy serves every running client
 * and cannot be configured per character. The routing has to be derived instead,
 * and the bots already hold the answer:
 *
 *   sro_client  --loopback-->  phBot listener  --outbound-->  SOCKS5
 *
 * Walking that chain backwards from the source port of the incoming request
 * yields the exact proxy that client's game session is using, with nothing for
 * the user to keep in sync.
 *
 * A phBot running WITHOUT a proxy still has one outbound connection: the game
 * server itself. Sending mall traffic there would be nonsense, so a candidate is
 * only accepted when it appears in the configured proxy list -- the allowlist is
 * what makes the guess safe.
 */
const LOOPBACK = a => a === '::1' || a.startsWith('127.');
const PRIVATE = a =>
  a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.') ||
  /^172\.(1[6-9]|2[0-9]|3[01])\./.test(a);

const splitAddr = a => {
  const i = a.lastIndexOf(':');
  return { addr: a.slice(0, i).replace(/^\[/, '').replace(/\]$/, ''), port: Number(a.slice(i + 1)) };
};

/**
 * The configured proxies, keyed by "host:port" so a discovered candidate can be
 * looked up directly. The file doubles as the allowlist, and it holds passwords,
 * so it is gitignored -- config/proxies.example.json is written beside it as a template.
 */
export function loadProxies(file = PROXIES_FILE) {
  if (!fs.existsSync(file)) return new Map();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.proxies ?? raw.socks5 ?? []);
  const map = new Map();
  for (const entry of list) {
    const p = parseProxy(entry);
    if (!p) continue;
    map.set(p.key, p);
    // Also reachable by bare IP. Discovery sees the port the BOT is using
    // (SOCKS5), which is not the port we may be told to connect on (the same
    // proxy often serves HTTP on another port), so the address alone has to be
    // enough to recognise it. An exact host:port entry still wins.
    if (!map.has(p.host)) map.set(p.host, p);
  }
  return map;
}

/**
 * One proxy, in whichever shape it was pasted:
 *
 *   host:port@user:pass        the order proxy sellers hand out, and the default
 *   host:port                  no credentials (IP-authorised proxies)
 *   http://host:port           an HTTP proxy instead of SOCKS5, same seller
 *   socks5://user:pass@host:port
 *
 * Protocol defaults to socks5, since that is the port phBot is pointed at. When
 * the same proxy also speaks HTTP, say so with an http:// entry: the mall is
 * plain HTTP, so that path needs no tunnel at all.
 *
 * Splitting rules are chosen so credentials survive: the FIRST "@" separates
 * address from login (an address never contains one, a password may), and the
 * first ":" of the login separates user from password (so a password may contain
 * ":" too). Port defaults to 1080.
 */
/**
 * How much this half looks like an address: 2 with a real port, 1 bare, 0 not.
 *
 * A plain boolean is not enough. In "http://1.2.3.4:8085@bot" both halves are
 * plausible hosts, and only the explicit port says which one is meant.
 */
function addressScore(s) {
  if (!s) return 0;
  const c = s.lastIndexOf(':');
  if (c === -1) return 1;
  const port = s.slice(c + 1);
  return (/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535) ? 2 : 0;
}

export function parseProxy(entry) {
  let text = String(entry ?? '').trim();
  if (!text || text.startsWith('#')) return null;

  let user = '', pass = '', address = text, protocol = 'socks5';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const m = text.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/i);
    protocol = /^https?$/i.test(m[1]) ? 'http' : 'socks5';
    const rest = m[2].replace(/\/+$/, '');
    const at = rest.lastIndexOf('@');
    if (at === -1) {
      address = rest;
    } else {
      // A URL puts the login first (user:pass@host:port), but the format this
      // file documents is the seller's order, and people paste that WITH the
      // scheme glued on (http://host:port@user:pass). Both are reasonable to
      // type, so the side that actually parses as an address wins, and a tie
      // falls back to URL order. Getting this wrong is silent: the login
      // becomes the hostname and the proxy is simply never reached.
      const left = rest.slice(0, at), right = rest.slice(at + 1);
      let login, decode;
      if (addressScore(left) > addressScore(right)) {
        address = left; login = right; decode = false;
      } else {
        login = left; address = right; decode = true;
      }
      const c = login.indexOf(':');
      user = c === -1 ? login : login.slice(0, c);
      pass = c === -1 ? '' : login.slice(c + 1);
      if (decode) { user = decodeURIComponent(user); pass = decodeURIComponent(pass); }
    }
    if (!address.includes(':')) address += protocol === 'http' ? ':8080' : ':1080';
  } else {
    const at = text.indexOf('@');
    if (at !== -1) {
      address = text.slice(0, at);
      const login = text.slice(at + 1);
      const colon = login.indexOf(':');
      user = colon === -1 ? login : login.slice(0, colon);
      pass = colon === -1 ? '' : login.slice(colon + 1);
    }
  }

  const colon = address.lastIndexOf(':');
  const host = (colon === -1 ? address : address.slice(0, colon)).replace(/^\[/, '').replace(/\]$/, '');
  const port = colon === -1 ? 1080 : Number(address.slice(colon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  // `key` is the address form discovery produces, so it can be matched. `id` is
  // unique per configured entry and is what connection pools are cached under.
  return { key: `${host}:${port}`, id: `${protocol}://${host}:${port}`, host, port, user, pass, protocol };
}

/**
 * The ONE way to ask "is this discovered address configured, and with what?".
 * Both the proxy and tools/mall-route.mjs must ask through here: when the same
 * question was answered in two places, the diagnostic tool reported addresses as
 * unconfigured that the proxy was happily routing.
 */
export const matchProxy = (proxies, key, host) => proxies.get(key) ?? proxies.get(host) ?? null;

/** Distinct proxies, not map entries -- each one is indexed under two keys. */
export const countProxies = proxies => new Set([...proxies.values()].map(p => p.id)).size;

let cache = { at: 0, rows: [] };

/** Parsed `netstat -ano`, cached briefly so a burst of requests costs one call. */
export function snapshot({ ttl = 5000, now = Date.now() } = {}) {
  if (now - cache.at < ttl) return cache.rows;
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
  } catch {
    return cache.rows;   // keep the last good view rather than losing routing
  }
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/);
    if (!m) continue;
    rows.push({ local: splitAddr(m[1]), remote: splitAddr(m[2]), state: m[3], pid: Number(m[4]) });
  }
  cache = { at: now, rows };
  return rows;
}

/**
 * Resolve the proxy for the client that opened `clientPort` against us.
 * `isAllowed('host:port')` gates every candidate. Returns null when the chain
 * cannot be walked, which the caller must treat as "go direct".
 */
export function findUpstream(clientPort, isAllowed, opts = {}) {
  const rows = snapshot(opts);
  // netstat lists both ends of a loopback connection. Matching the far end's
  // port as well pins down the client's own row rather than an unrelated socket
  // that happens to hold the same local port on another interface.
  const client = rows.find(r =>
    r.state === 'ESTABLISHED' && r.local.port === clientPort &&
    (opts.selfPort === undefined || r.remote.port === opts.selfPort));
  if (!client) return null;
  return walk(rows, client.pid, isAllowed);
}

/** Same walk, entered from a process id. Used by tools/mall-route.mjs. */
export function upstreamForPid(clientPid, isAllowed, opts = {}) {
  return walk(snapshot(opts), clientPid, isAllowed);
}

function walk(rows, clientPid, isAllowed) {
  const listeners = new Map();
  for (const r of rows) if (r.state === 'LISTENING') listeners.set(r.local.port, r.pid);

  for (const hop of rows) {
    if (hop.pid !== clientPid || hop.state !== 'ESTABLISHED') continue;
    if (!LOOPBACK(hop.remote.addr)) continue;
    const botPid = listeners.get(hop.remote.port);
    if (!botPid || botPid === clientPid) continue;

    for (const out of rows) {
      if (out.pid !== botPid || out.state !== 'ESTABLISHED') continue;
      if (LOOPBACK(out.remote.addr) || PRIVATE(out.remote.addr)) continue;
      const key = `${out.remote.addr}:${out.remote.port}`;
      // The address is offered both ways: the exact host:port the bot is using,
      // and the bare host, because the configured entry may name another port
      // on the same proxy.
      if (!isAllowed(key, out.remote.addr)) continue;
      return { key, host: out.remote.addr, port: out.remote.port, clientPid, botPid };
    }
  }
  return null;
}

/** Process name for a pid, for error messages. Empty string when unknown. */
export function processName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true });
    return out.match(/^"([^"]+)"/)?.[1] ?? '';
  } catch {
    return '';
  }
}

/** Which pid is listening on a local port, if any. */
export function listenerOn(port) {
  return snapshot({ ttl: 0 }).find(r => r.state === 'LISTENING' && r.local.port === port)?.pid;
}
