import fs from 'node:fs';
import { parseProxy, loadProxies } from '../src/route.mjs';

/**
 * Proxy-list parsing. The pasted format is "host:port@user:pass" -- the order
 * proxy sellers use, which is the reverse of a URL's. Credentials are pasted
 * verbatim, so the separators have to survive punctuation inside a password.
 */
let pass = 0;
const fails = [];
const check = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++; else fails.push(`${name}\n      got  ${a}\n      want ${b}`);
};
const parts = s => {
  const p = parseProxy(s);
  return p && [p.host, p.port, p.user, p.pass];
};

check('pasted format', parts('1.2.3.4:22231@bot:secret'), ['1.2.3.4', 22231, 'bot', 'secret']);
check('port defaults to 1080', parts('1.2.3.4@bot:secret'), ['1.2.3.4', 1080, 'bot', 'secret']);
check('no credentials at all', parts('1.2.3.4:1080'), ['1.2.3.4', 1080, '', '']);

// A password is copied as-is and may hold the very characters used as
// separators. The address never contains "@", so the FIRST one splits.
check('password containing @', parts('1.2.3.4:1080@bot:se@cret'), ['1.2.3.4', 1080, 'bot', 'se@cret']);
check('password containing :', parts('1.2.3.4:1080@bot:se:cret'), ['1.2.3.4', 1080, 'bot', 'se:cret']);
check('password containing both', parts('1.2.3.4:1080@bot:p@ss:w0rd'), ['1.2.3.4', 1080, 'bot', 'p@ss:w0rd']);
check('username with no password', parts('1.2.3.4:1080@bot'), ['1.2.3.4', 1080, 'bot', '']);

// The URL form stays supported so an existing list keeps working.
check('url form', parts('socks5://bot:secret@1.2.3.4:1080'), ['1.2.3.4', 1080, 'bot', 'secret']);
check('url form percent-encoded', parts('socks5://bot:p%40ss@1.2.3.4:1080'), ['1.2.3.4', 1080, 'bot', 'p@ss']);

// A scheme and the pasted order get combined, because this file documents both
// and gluing them together is the obvious thing to type. Whichever half really
// parses as an address wins; only a tie falls back to URL order. Read the wrong
// way round, the login silently becomes the hostname and the proxy is never
// reached -- no error, just a mall that will not load.
check('scheme with the pasted order', parts('http://1.2.3.4:8085@bot:secret'),
  ['1.2.3.4', 8085, 'bot', 'secret']);
check('scheme, pasted order, login has no port', parts('http://1.2.3.4:8085@bot'),
  ['1.2.3.4', 8085, 'bot', '']);
check('scheme, url order, user only', parts('socks5://bot@1.2.3.4:1080'),
  ['1.2.3.4', 1080, 'bot', '']);
check('a tie falls back to url order', parts('socks5://5.6.7.8:1080@1.2.3.4:1080'),
  ['1.2.3.4', 1080, '5.6.7.8', '1080']);
check('the pasted order keeps its protocol',
  parseProxy('http://1.2.3.4:8085@bot:secret').protocol, 'http');

// --- protocol -------------------------------------------------------------
// SOCKS5 is the default because that is the port phBot is pointed at.
check('default protocol is socks5', parseProxy('1.2.3.4:1080').protocol, 'socks5');
check('http scheme', parseProxy('http://1.2.3.4:8080').protocol, 'http');
check('http port defaults to 8080', parseProxy('http://1.2.3.4').port, 8080);
check('socks5 port defaults to 1080', parseProxy('socks5://1.2.3.4').port, 1080);
check('http with credentials', parts('http://bot:secret@1.2.3.4:8080'), ['1.2.3.4', 8080, 'bot', 'secret']);
check('id distinguishes protocol on one host', parseProxy('http://1.2.3.4:1080').id, 'http://1.2.3.4:1080');

check('blank is skipped', parseProxy('   '), null);
check('comment line is skipped', parseProxy('# 1.2.3.4:1080@a:b'), null);
check('impossible port is refused', parseProxy('1.2.3.4:99999@a:b'), null);
check('non-numeric port is refused', parseProxy('1.2.3.4:abc@a:b'), null);

// --- file shapes ----------------------------------------------------------
const file = '.test-proxies.json';

fs.writeFileSync(file, JSON.stringify(['1.2.3.4:1080@bot:secret', '5.6.7.8:22231']));
const both = loadProxies(file);
check('bare array file', [...new Set([...both.values()].map(p => p.id))],
  ['socks5://1.2.3.4:1080', 'socks5://5.6.7.8:22231']);
check('exact address resolves', both.get('1.2.3.4:1080')?.port, 1080);
// Discovery reports the port the BOT uses, so the bare address must resolve too.
check('bare host resolves to the same entry', both.get('1.2.3.4')?.id, 'socks5://1.2.3.4:1080');
check('credentials survive the file round-trip', both.get('5.6.7.8')?.user, '');

fs.writeFileSync(file, JSON.stringify({ _comment: 'notes', proxies: ['1.2.3.4:1080@bot:secret'] }));
check('object with proxies key', loadProxies(file).get('1.2.3.4:1080')?.port, 1080);

fs.writeFileSync(file, JSON.stringify({ socks5: ['socks5://bot:secret@1.2.3.4:1080'] }));
check('older socks5 key still read', loadProxies(file).get('1.2.3.4:1080')?.protocol, 'socks5');

// The whole point of matching on the bare address: the same seller serves HTTP
// on another port, and the bot is pointed at the SOCKS5 one.
fs.writeFileSync(file, JSON.stringify(['http://1.2.3.4:8080']));
const httpOnly = loadProxies(file);
check('http entry is found by bare address', httpOnly.has('1.2.3.4'), true);
check('and it is the http entry', httpOnly.get('1.2.3.4')?.protocol, 'http');
check('with its own port', httpOnly.get('1.2.3.4')?.port, 8080);

// Listing both: the exact address the bot uses wins, which is predictable.
fs.writeFileSync(file, JSON.stringify(['1.2.3.4:1080', 'http://1.2.3.4:8080']));
const mixed = loadProxies(file);
check('exact match beats the bare address', mixed.get('1.2.3.4:1080')?.protocol, 'socks5');
check('http entry still addressable', mixed.get('http://1.2.3.4:8080') ?? mixed.get('1.2.3.4:8080')?.protocol, 'http');

check('missing file means no routing', loadProxies('.does-not-exist.json').size, 0);
fs.rmSync(file, { force: true });

// The key must match what discovery builds from netstat, or nothing routes.
check('key is host:port', parseProxy('1.2.3.4:1080@bot:secret').key, '1.2.3.4:1080');

for (const f of fails) console.log(`  FAIL  ${f}`);
console.log(`  ${fails.length ? 'FAIL' : 'PASS'}  route: ${pass}/${pass + fails.length} checks`);
process.exit(fails.length ? 1 : 0);
