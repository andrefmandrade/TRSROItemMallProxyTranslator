import dns from 'node:dns';
import http from 'node:http';

/**
 * Which mall address to actually talk to.
 *
 * mall.gamegami.com resolves to several A records and not all of them work:
 * measured on 2026-09-03, two of the three completed the TCP handshake and then
 * never sent a byte, so a request landing on one hung until it timed out. DNS
 * hands them out in rotation, so roughly two connections in three stalled --
 * which is what made the mall look randomly broken and randomly slow.
 *
 * Node does not fail over between a hostname's addresses; it resolves one and
 * sticks with it. So the address is chosen here instead: the last one known to
 * answer is preferred, a bad one is parked, and the list is re-resolved
 * periodically in case the operator fixes or rotates a server.
 *
 * The Host header must stay the hostname -- only the connection target changes.
 */
const TTL = 5 * 60 * 1000;

let cache = { at: 0, addresses: [] };
const bad = new Map();      // address -> when it was parked
const PARK = 2 * 60 * 1000; // how long a silent address is skipped

export async function addresses(host, { now = Date.now() } = {}) {
  if (now - cache.at < TTL && cache.addresses.length) return cache.addresses;
  const found = await new Promise(resolve => {
    // resolve4 queries DNS directly, so this keeps working even if someone
    // later points the hosts file at a local address.
    dns.resolve4(host, (err, list) => resolve(err ? [] : list));
  });
  if (found.length) cache = { at: now, addresses: found };
  return cache.addresses;
}

/** Addresses worth trying: everything not currently parked. */
export async function candidates(host, { now = Date.now() } = {}) {
  const all = await addresses(host, { now });
  if (!all.length) return [];

  // A parked address is NOT released just because time passed. It used to be,
  // and the cost landed on the player: a mall page pulls ~72 images, so as soon
  // as a dead address came back into rotation dozens of those requests stalled
  // for the full timeout and the client froze mid-page. Re-test it in the
  // background instead, and keep it parked until it actually answers.
  for (const [ip, at] of bad) {
    if (now - at > PARK) {
      bad.set(ip, now);          // hold it while the check runs
      recheck(ip, host);         // deliberately not awaited
    }
  }

  const live = all.filter(ip => !bad.has(ip));
  // If every address is parked, the fault is more likely to be local than
  // universal, so try them all rather than refusing to work at all.
  return live.length ? live : all;
}

const checking = new Set();

/** Probe one parked address; release it only if it answers. */
async function recheck(ip, host) {
  if (checking.has(ip)) return;
  checking.add(ip);
  try {
    const ok = await probeOne(ip, host, probePath);
    if (ok) markGood(ip);
  } finally {
    checking.delete(ip);
  }
}

export function markBad(ip, { now = Date.now() } = {}) {
  if (ip) bad.set(ip, now);
}

export function markGood(ip) {
  bad.delete(ip);
}

/** For logging: which addresses are currently parked. */
export const parked = () => [...bad.keys()];

// Remembered so a background re-check asks for the same thing the startup probe
// did, instead of guessing at a path.
let probePath = '/';

/** Does this address answer at all? Resolves true/false, never throws. */
function probeOne(ip, host, path, timeout = 4000) {
  return new Promise(resolve => {
    const req = http.request({
      host: ip, port: 80, path, method: 'HEAD',
      headers: { host, 'user-agent': 'mall-proxy/probe' },
    }, res => {
      res.resume();
      resolve(true);
    });
    // The dead servers accept the connection and then say nothing, so a response
    // timeout is the only thing that catches them.
    req.setTimeout(timeout, () => req.destroy(new Error('silent')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

/**
 * Check every address once, in parallel, and park the ones that do not answer.
 * Without this the first real request pays the timeout of a dead server before
 * failing over -- eight seconds of nothing, on the page the user is watching.
 */
export async function probe(host, { path = '/', timeout = 4000 } = {}) {
  probePath = path;
  const all = await addresses(host);
  const results = await Promise.all(
    all.map(ip => probeOne(ip, host, path, timeout).then(ok => ({ ip, ok }))));

  for (const r of results) r.ok ? markGood(r.ip) : markBad(r.ip);
  return results;
}
