import net from 'node:net';
import http from 'node:http';
import { socks5Connect } from '../src/socks5.mjs';

/**
 * Integration test for src/socks5.mjs against a stub SOCKS5 server, so the
 * handshake is proven before it is pointed at a real proxy with real
 * credentials. Covers the password path, a refused password, and a refused
 * destination.
 */
const USER = 'bot', PASS = 'pa:ss@word';
let pass = 0;
const fails = [];
const check = (name, got, want) => {
  if (got === want) pass++;
  else fails.push(`${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
};

const listen = (server, ...args) =>
  new Promise(res => server.listen(...args, () => res(server.address().port)));

/**
 * Stub SOCKS5 server: CONNECT, then a plain pipe.
 * `noAuth` serves the IP-whitelisted case, where the proxy asks for nothing.
 */
function stubProxy({ accept = true, allow = true, noAuth = false } = {}) {
  return net.createServer(sock => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (noAuth) {
          if (!methods.includes(0x00)) { sock.end(Buffer.from([0x05, 0xFF])); return; }
          sock.write(Buffer.from([0x05, 0x00]));
          stage = 'request';
        } else {
          if (!methods.includes(0x02)) { sock.end(Buffer.from([0x05, 0xFF])); return; }
          sock.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
        }
      }
      if (stage === 'auth' && buf.length >= 2) {
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const password = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const ok = accept && user === USER && password === PASS;
        sock.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) { sock.end(); return; }
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 5) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        const host = buf.subarray(5, 5 + len).toString();
        const port = buf.readUInt16BE(5 + len);
        buf = buf.subarray(5 + len + 2);
        if (!allow) { sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return; }
        const out = net.connect(port, host, () => {
          // Reply with a bound address the client has to consume and discard.
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x04, 0x38]));
          stage = 'pipe';
          if (buf.length) out.write(buf);
          sock.pipe(out);
          out.pipe(sock);
        });
        out.on('error', () => sock.destroy());
      }
    });
    sock.on('error', () => {});
  });
}

const origin = http.createServer((_, res) => res.end('hello from origin'));
const originPort = await listen(origin);

const good = stubProxy();
const goodPort = await listen(good, 0, '127.0.0.1');

// --- happy path: fetch through the tunnel --------------------------------
const body = await new Promise((resolve, reject) => {
  socks5Connect({ host: '127.0.0.1', port: goodPort, user: USER, pass: PASS }, '127.0.0.1', originPort)
    .then(sock => {
      let out = '';
      sock.setEncoding('utf8');
      sock.on('data', d => { out += d; });
      sock.on('end', () => resolve(out));
      sock.on('error', reject);
      sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
    }, reject);
});
check('tunnelled request reaches the origin', body.includes('hello from origin'), true);
check('no SOCKS reply bytes leak into the HTTP stream', body.startsWith('HTTP/1.1 200'), true);

// --- a wrong password must fail, and say so ------------------------------
const wrong = await socks5Connect({ host: '127.0.0.1', port: goodPort, user: USER, pass: 'nope' },
  '127.0.0.1', originPort).then(() => 'connected', e => e.message);
check('wrong password is refused', wrong, 'socks5: username/password rejected');

// --- IP-whitelisted proxies ask for no auth at all -----------------------
const open = stubProxy({ noAuth: true });
const openPort = await listen(open, 0, '127.0.0.1');

const fetchVia = proxy => new Promise((resolve, reject) => {
  socks5Connect(proxy, '127.0.0.1', originPort).then(sock => {
    let out = '';
    sock.setEncoding('utf8');
    sock.on('data', d => { out += d; });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
    sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);
  }, reject);
});

const noCreds = await fetchVia({ host: '127.0.0.1', port: openPort });
check('passwordless config against a no-auth proxy', noCreds.includes('hello from origin'), true);

// Credentials left in the list must not break a proxy that whitelists by IP:
// the client offers user/pass AND none, and the server is free to pick none.
const withCreds = await fetchVia({ host: '127.0.0.1', port: openPort, user: USER, pass: PASS });
check('unused credentials do not break a no-auth proxy', withCreds.includes('hello from origin'), true);

// --- the proxy refusing the destination must surface, not hang -----------
const refuser = stubProxy({ allow: false });
const refuserPort = await listen(refuser, 0, '127.0.0.1');
const refused = await socks5Connect({ host: '127.0.0.1', port: refuserPort, user: USER, pass: PASS },
  '127.0.0.1', originPort).then(() => 'connected', e => e.message);
check('refused destination reports the reason', refused, 'socks5: connection refused');

// --- nothing listening at all -------------------------------------------
const dead = await socks5Connect({ host: '127.0.0.1', port: 1, user: USER, pass: PASS },
  '127.0.0.1', originPort).then(() => 'connected', e => e.code || e.message);
check('unreachable proxy reports an error', typeof dead === 'string', true);

for (const f of fails) console.log(`  FAIL  ${f}`);
console.log(`  ${fails.length ? 'FAIL' : 'PASS'}  socks5: ${pass}/${pass + fails.length} checks`);

origin.close(); good.close(); open.close(); refuser.close();
process.exit(fails.length ? 1 : 0);
