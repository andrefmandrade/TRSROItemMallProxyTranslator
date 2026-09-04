import { execFileSync } from 'node:child_process';
import { loadProxies, upstreamForPid, matchProxy, countProxies } from './route.mjs';
import { PROXIES_FILE } from './paths.mjs';

/**
 * Show which proxy each running client would have its mall traffic sent through,
 * without sending anything. Worth running before trusting the routing, and again
 * whenever a pairing looks wrong.
 *
 * Candidates outside proxies.json are shown but marked, because that list is the
 * allowlist: a bot with no proxy of its own has the GAME SERVER as its only
 * outbound connection, and it turns up here looking just like a proxy. Nothing
 * unlisted is ever used at runtime.
 *
 * Lives in src/ rather than in the tool so the executable can offer it too
 * (--routes): the people running the exe are exactly the ones with no other way
 * to check.
 */
const clients = () => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq sro_client.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true });
    return [...out.matchAll(/"sro_client\.exe","(\d+)"/gi)].map(m => Number(m[1]));
  } catch {
    return [];
  }
};

export function reportRoutes(log = console.log) {
  const proxies = loadProxies();
  const pids = clients();

  log(`${PROXIES_FILE}: ${countProxies(proxies)} proxy(ies) configured`);
  log(`sro_client running: ${pids.length}\n`);

  if (!pids.length) log('  no client running -- start one and run this again');

  let listed = 0, unlisted = 0, none = 0;
  for (const pid of pids.sort((a, b) => a - b)) {
    const found = upstreamForPid(pid, () => true, { ttl: 0 });
    if (!found) {
      none++;
      log(`  pid ${String(pid).padEnd(6)} no bot hop found -> mall would go out DIRECT (your own IP)`);
      continue;
    }
    // The same lookup the proxy uses, so this report cannot disagree with it.
    const cfg = matchProxy(proxies, found.key, found.host);
    if (cfg) listed++; else unlisted++;
    log(`  pid ${String(pid).padEnd(6)} bot ${String(found.botPid).padEnd(6)} -> ${found.key}`
      + (cfg ? `  [mall goes via ${cfg.id}]` : '  [NOT configured -- would go DIRECT]'));
  }

  if (unlisted) {
    log(`\n  ${unlisted} address(es) are not configured. Add the real ones as`);
    log('  "host:port", "host:port@user:pass" or "http://host:port". Check each one really');
    log('  is a proxy first -- a bot with no proxy shows the game server here.');
  }
  log(`\n  ${listed} routed, ${unlisted} unlisted, ${none} without a bot hop`);

  return { listed, unlisted, none };
}
