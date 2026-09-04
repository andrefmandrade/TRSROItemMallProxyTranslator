import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { loadDictionary, createTranslator } from '../src/translate.mjs';
import { loadProxies, findUpstream, snapshot, matchProxy, countProxies, listenerOn, processName } from '../src/route.mjs';
import { socks5Connect } from '../src/socks5.mjs';
import { candidates, markBad, markGood, parked, probe } from '../src/host.mjs';
import { ensureConfig, CONFIG_DIR, CAPTURES_DIR, UNTRANSLATED_FILE, BUNDLED } from '../src/paths.mjs';
import { reportRoutes } from '../src/report.mjs';

/**
 * Local proxy that translates the webmall's visible text.
 *
 * Because the WinINet proxy setting is system-wide, browsers and Electron apps
 * route through here too. So this proxy must be a good citizen:
 *   - CONNECT is tunnelled untouched, so HTTPS keeps working everywhere
 *   - any host other than the mall is passed straight through
 *   - it serves a PAC file at /proxy.pac so only the mall is proxied at all
 *
 * Translation guarantees (see src/translate.mjs):
 *   - only text BETWEEN tags is rewritten; attributes are never touched
 *   - <script> and <style> bodies are excluded
 *   - a chunk is reverted if its numbers change, so prices cannot move
 */
const HOST = 'mall.gamegami.com';
const PORT = Number(process.env.PORT || 8080);

// Write config/ before anything reads it, so a first run on a bare folder has a
// dictionary to load and a proxies.json to look at.
const seeded = ensureConfig();
const dict = loadDictionary();
const { rewrite, stats } = createTranslator(dict);

// CAPTURE=1 saves every mall page it serves, so coverage can be measured from
// real browsing instead of from an assumption about which pages matter.
const CAPTURE = process.env.CAPTURE === '1';
const CAPTURE_DIR = CAPTURES_DIR;
const PENDING_FILE = UNTRANSLATED_FILE;
if (CAPTURE) fs.mkdirSync(CAPTURE_DIR, { recursive: true });

function record(urlPath, body) {
  if (CAPTURE) {
    const safe = urlPath.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-60) || 'index';
    fs.writeFileSync(path.join(CAPTURE_DIR, `${Date.now()}_${safe}.html`), body);
  }
  // Always refresh the live gap list; it is the whole point of not assuming.
  const rows = [...stats.pending]
    .sort((a, b) => b[1] - a[1])
    .map(([text, n]) => ({ n, text }));
  fs.writeFileSync(PENDING_FILE, JSON.stringify(rows, null, 1));
  return rows.length;
}

// Each client's mall request is sent out through the same SOCKS5 proxy its own
// phBot is using, so the mall and the game session share one IP. See
// src/route.mjs for why this has to be discovered rather than configured.
const proxies = loadProxies();
const agents = new Map();
const routed = new Map();

// One mall page pulls in css, js and dozens of item images. Left unbounded,
// every one of those opened its own connection to the proxy in a burst -- and
// proxy sellers cap concurrent connections, so the burst gets refused and the
// page dies half-loaded. A small pool, reused, is what these settings buy.
// A page also pulls dozens of item images, and serialising those makes it crawl.
// 2 was a panic value chosen while every connection cost a SOCKS5 handshake; an
// HTTP proxy has no handshake, so the pool can be wider. Tune with MAX_SOCKETS
// if a seller starts refusing connections again.
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS || 8);
const POOL = {
  keepAlive: true,
  keepAliveMsecs: 10000,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_SOCKETS,
  timeout: 30000,
};

function agentFor(proxy) {
  if (!agents.has(proxy.id)) {
    if (proxy.protocol === 'http') {
      // Nothing custom needed: an HTTP proxy takes an absolute URI on a normal
      // connection, so a stock agent pools it.
      agents.set(proxy.id, new http.Agent(POOL));
    } else {
      class Socks5Agent extends http.Agent {
        createConnection(opts, cb) {
          socks5Connect(proxy, opts.host, Number(opts.port) || 80).then(s => cb(null, s), cb);
        }
      }
      agents.set(proxy.id, new Socks5Agent(POOL));
    }
  }
  return agents.get(proxy.id);
}

/** The proxy this request must go out through, or null for a direct connection. */
function routeFor(req) {
  if (!proxies.size) return null;
  const found = findUpstream(req.socket.remotePort,
    (key, host) => !!matchProxy(proxies, key, host), { selfPort: PORT });
  if (!found) return null;
  // An exact host:port entry wins; otherwise the bare address matches, which is
  // how an http:// entry on a different port still gets picked up.
  const cfg = matchProxy(proxies, found.key, found.host);
  // Report each client/proxy pair once, so a wrong pairing is visible rather
  // than silently shaping every request that follows.
  if (routed.get(found.clientPid) !== cfg.id) {
    routed.set(found.clientPid, cfg.id);
    console.log(`  route: client pid ${found.clientPid} (phBot ${found.botPid})`
      + ` uses ${found.key} -> sending mall via ${cfg.id}`);
  }
  return { ...cfg, clientPid: found.clientPid };
}

// Which client each request came from, even when it is not being routed, so a
// log line can be tied to one character rather than to the machine as a whole.
function clientPidOf(req) {
  const row = snapshot().find(r =>
    r.state === 'ESTABLISHED' && r.local.port === req.socket.remotePort && r.remote.port === PORT);
  return row?.pid;
}

// The mall's own failure page. Worth calling out in the log: it means the request
// reached the mall and the MALL refused it, which is a very different problem
// from the proxy or the tunnel failing.
const MALL_ERROR = /Bir hata olu|An error occurred/i;

/**
 * Undo the content encoding so the text can be rewritten. Returns null when the
 * body cannot be decoded, and the caller then passes the response through
 * untouched: rewriting compressed bytes would corrupt the page outright, which
 * is far worse than serving one page untranslated.
 */
function decode(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (!enc || enc === 'identity') return buf;
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch {
    return null;
  }
  return null;
}

const PAC = `function FindProxyForURL(url, host) {
  if (host === "${HOST}" || dnsDomainIs(host, ".${HOST}")) return "PROXY 127.0.0.1:${PORT}";
  return "DIRECT";
}
`;

/**
 * Die loudly, not silently.
 *
 * Double-clicking the executable gives a console window that closes the instant
 * the process exits, so an error that is merely printed is an error nobody ever
 * reads -- the window just vanishes and the tool looks broken for no reason.
 * Hold it open until a key is pressed.
 */
function fatal(lines) {
  console.error('');
  for (const line of [].concat(lines)) console.error(line);
  if (BUNDLED && process.stdin.isTTY) {
    console.error('');
    console.error('Press any key to close...');
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
      return;
    } catch { /* no console to wait on; fall through */ }
  }
  process.exit(1);
}

// Anything unexpected still has to reach the screen rather than close the window.
process.on('uncaughtException', e => fatal(`Unexpected error: ${e?.stack || e}`));
process.on('unhandledRejection', e => fatal(`Unexpected error: ${e?.stack || e}`));

/** Explain a port clash in terms of what to do about it, then hold the window. */
function portInUse() {
  const pid = listenerOn(PORT);
  const name = pid ? processName(pid) : '';
  fatal([
    `Port ${PORT} is already in use${pid ? ` by pid ${pid}${name ? ` (${name})` : ''}` : ''}.`,
    '',
    'Most likely this proxy is already running -- look for another window of it.',
    'Only one copy is needed, and the one already running is doing the job.',
    '',
    'To run this one on a different port instead:',
    '  set PORT=8081',
    `  ${BUNDLED ? path.basename(process.execPath) : 'npm start'}`,
    '',
    'The auto-config address in Windows then has to match that port:',
    '  http://127.0.0.1:8081/proxy.pac',
  ]);
}

// How long to wait for the mall to answer before writing that address off. The
// dead servers complete the handshake and then say nothing, so only a response
// timeout catches them -- a connect timeout never fires.
const ANSWER_TIMEOUT = Number(process.env.ANSWER_TIMEOUT || 8000);

const server = http.createServer(async (req, res) => {
  // Origin-form request (not proxied): serve the PAC file or a hint.
  if (!/^https?:\/\//i.test(req.url)) {
    if (req.url.startsWith('/proxy.pac')) {
      res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig' });
      res.end(PAC);
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`mall proxy is running.\nPoint Internet Options at http://127.0.0.1:${PORT}/proxy.pac\n`);
    }
    return;
  }

  const target = new URL(req.url);
  const headers = { ...req.headers };
  // Ask for compression rather than refusing it. A mall page is ~39KB of HTML
  // and the no-store rule means it is fetched fresh every view, so sending it
  // uncompressed through the proxy on every open was pure waste. It is
  // decompressed here before the text is rewritten.
  headers['accept-encoding'] = 'gzip, deflate';

  // Only mall traffic is routed; anything else keeps going out directly.
  const route = target.hostname.toLowerCase().endsWith(HOST) ? routeFor(req) : null;

  // Pick the mall address ourselves instead of letting a hostname lookup decide.
  // Two of the three A records accept connections and never answer, and nothing
  // in the stack fails over between them (see src/host.mjs).
  const isMallHost = target.hostname.toLowerCase().endsWith(HOST);
  const ips = isMallHost ? await candidates(HOST) : [];

  const buildOpts = ip => {
    // The connection target changes; the Host header must not, or IIS serves
    // the wrong site.
    const out = {
      host: ip || target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...headers, host: target.host },
    };
    if (!route) return out;

    out.agent = agentFor(route);
    if (route.protocol === 'http') {
      // An HTTP proxy is handed the absolute URI on an ordinary connection --
      // no tunnel, no handshake. The chosen address goes into that URI so the
      // proxy connects where we want, while Host still names the mall.
      out.host = route.host;
      out.port = route.port;
      out.path = ip
        ? `http://${ip}${target.pathname}${target.search}`
        : req.url;
      if (route.user) {
        out.headers['proxy-authorization'] =
          'Basic ' + Buffer.from(`${route.user}:${route.pass}`).toString('base64');
      }
    }
    return out;
  };

  // A cold connection pool drops the occasional first request, which is why the
  // first page load came up short. One retry covers that.
  //
  // GET and HEAD only. The mall's purchase flow is a POST, and re-sending a POST
  // could buy the item a second time -- so a failed POST stays failed and shows
  // up in the log. Never widen this to every method.
  const retriable = req.method === 'GET' || req.method === 'HEAD';
  let attempt = 0;

  const send = () => {
  const started = Date.now();
  // Each attempt moves to the next address, so a silent server is stepped over
  // instead of being hit again.
  const ip = ips.length ? ips[(attempt) % ips.length] : null;
  attempt++;
  const up = http.request(buildOpts(ip), r => {
    if (ip) markGood(ip);
    const isMall = target.hostname.toLowerCase().endsWith(HOST);
    const isHtml = /text\/html/i.test(r.headers['content-type'] || '');
    if (!isMall || !isHtml) {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
      return;
    }

    const buf = [];
    r.on('data', c => buf.push(c));
    r.on('end', () => {
      const raw = Buffer.concat(buf);
      const decoded = decode(raw, r.headers['content-encoding']);
      if (decoded === null) {
        console.error(`pid ${route?.clientPid ?? clientPidOf(req) ?? '?'}`
          + `  could not decode ${r.headers['content-encoding']} for ${target.pathname}`
          + `  -- passed through UNTRANSLATED`);
        res.writeHead(r.statusCode, r.headers);
        res.end(raw);
        return;
      }

      const was = { ...stats };
      const original = decoded.toString('utf8');
      const body = rewrite(original);
      const out = { ...r.headers };
      delete out['content-encoding'];
      // Chunked plus an explicit length is invalid and fails intermittently;
      // we send one buffered body, so the length is the only framing header.
      delete out['transfer-encoding'];
      out['content-length'] = Buffer.byteLength(body);

      // MSHTML caches through WinINet, so a page fetched before the proxy existed
      // keeps being served from disk -- untranslated, and never reaching us at all.
      // Forbid caching of mall pages so every view goes through the translator.
      delete out['etag'];
      delete out['last-modified'];
      out['cache-control'] = 'no-store, no-cache, must-revalidate';
      out['pragma'] = 'no-cache';
      out['expires'] = '0';
      res.writeHead(r.statusCode, out);
      res.end(body);
      const kept = stats.reverted - was.reverted;
      // Capture the ORIGINAL page, not the translated one: coverage has to be
      // measured against what the mall sends, otherwise it just re-reads our own
      // output and reports success.
      const gaps = record(target.pathname, original);
      // Lead with the client and its exit IP: with several clients running, a
      // line that only names the path cannot tell you WHICH character failed.
      const who = `pid ${route?.clientPid ?? clientPidOf(req) ?? '?'}`;
      const via = route ? route.id : 'DIRECT';
      // Timing is here because 'it felt slow' is not something a log can answer
      // afterwards, and the slow request is the one worth knowing about.
      const ms = Date.now() - started;
      console.log(`${who} via ${via}  ${r.statusCode} ${target.pathname}  ${ms}ms`
        + `  translated ${stats.changed - was.changed}`
        + (kept ? `, kept ${kept} (numbers would have changed)` : '')
        + (gaps ? `  |  ${gaps} untranslated` : '')
        + (MALL_ERROR.test(original) ? '   <-- MALL REFUSED THIS (its own error page)' : ''));
    });
  });

  // A server that accepts the connection and then stays quiet only shows up as
  // a response timeout, so this is what catches the dead mall addresses.
  up.setTimeout(ANSWER_TIMEOUT, () => {
    up.destroy(new Error(`no answer within ${ANSWER_TIMEOUT}ms`));
  });

  up.on('error', e => {
    // Name the client, the exit and the address: a rejected password, a dead
    // proxy and a silent mall server all arrive here, and without those three
    // it just looks like the mall is broken for everyone.
    const who = `pid ${route?.clientPid ?? clientPidOf(req) ?? '?'} via ${route ? route.id : 'DIRECT'}`
      + (ip ? ` to ${ip}` : '');
    if (ip) markBad(ip);
    // Step through the addresses before giving up. GET/HEAD only -- a POST is a
    // purchase and must never be replayed.
    if (retriable && !res.headersSent && attempt < Math.max(ips.length, 2)) {
      console.error(`${who}  ${e.message} -- trying the next address`);
      send();
      return;
    }
    console.error(`${who}  FAILED ${target.pathname}: ${e.message}`
      + (retriable ? ` (tried ${attempt} address(es))` : ' (POST -- deliberately not retried)'));
    if (!res.headersSent) res.writeHead(502);
    res.end('upstream error');
  });

    // A GET carries no body, so the retry can simply be re-sent. Anything that
    // does carry one is piped through once and never repeated.
    if (retriable) up.end();
    else req.pipe(up);
  };
  send();
});

// HTTPS: open a raw tunnel and stay out of it. Nothing is inspected or altered.
server.on('connect', (req, clientSocket, head) => {
  const [host, port = '443'] = req.url.split(':');
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const drop = () => { upstream.destroy(); clientSocket.destroy(); };
  upstream.on('error', drop);
  clientSocket.on('error', drop);
});

// Kept inside a function rather than awaited at the top level, because the
// executable is built from a CommonJS bundle and top-level await cannot survive
// that conversion.
async function main() {
// `--routes` prints the pairing and exits. The executable has no other way to
// offer it, and it is the check that stops a wrong pairing going unnoticed.
if (process.argv.includes('--routes')) {
  reportRoutes();
  return;
}

// Find out which mall addresses answer BEFORE serving anything, so the first
// page does not pay a dead server's timeout.
const checked = await probe(HOST, { path: '/itemmall/itemBuyGame/gameMallGate.asp' });

// Registered here so it is attached after the server exists, and before listen
// can fail. A port clash used to be an unhandled error: the process died and the
// window closed too fast to read, which is exactly how this looked like the exe
// "closing by itself".
server.on('error', e => (e.code === 'EADDRINUSE' ? portInUse() : fatal(`Could not start: ${e.message}`)));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mall proxy listening on http://127.0.0.1:${PORT}`);
  console.log(`  dictionary : ${dict.pairs.length} strings + ${dict.patterns.length} patterns`);
  console.log(`  rewriting  : ${HOST} only`);
  console.log(`  HTTPS      : tunnelled untouched (CONNECT)`);
  const live = checked.filter(c => c.ok).map(c => c.ip);
  const dead = checked.filter(c => !c.ok).map(c => c.ip);
  console.log(`  mall hosts : ${live.length}/${checked.length} answering`
    + (live.length ? `  using ${live.join(', ')}` : '')
    + (dead.length ? `  |  silent: ${dead.join(', ')}` : ''));
  console.log(proxies.size
    ? `  routing    : ${countProxies(proxies)} proxy(ies) configured; each client follows its own bot`
    : `  routing    : DIRECT -- the mall goes out on your own IP`);
  console.log(`  config     : ${CONFIG_DIR}`);
  for (const f of seeded) console.log(`               wrote ${f}`);
  console.log('');
  console.log(`  Point Windows at this proxy ONCE:`);
  console.log(`  inetcpl.cpl > Connections > LAN settings > Use automatic configuration script`);
  console.log(`  Address: http://127.0.0.1:${PORT}/proxy.pac`);
  console.log('');
  console.log(`  Leave this window open while you play. Ctrl+C to stop.`);
});
}

main().catch(e => fatal(`Could not start: ${e?.stack || e}`));
