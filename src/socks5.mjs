import net from 'node:net';

/**
 * Minimal SOCKS5 client (RFC 1928) with username/password auth (RFC 1929).
 *
 * Hand-rolled rather than pulled from npm: it is about sixty lines, and this
 * project deliberately carries one dependency. Only what the mall proxy needs is
 * implemented -- CONNECT to a hostname, no BIND, no UDP, no IPv6 literals.
 */
const V5 = 0x05;
const AUTH_NONE = 0x00, AUTH_USERPASS = 0x02, AUTH_NONE_ACCEPTABLE = 0xFF;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01, ATYP_DOMAIN = 0x03, ATYP_IPV6 = 0x04;

const REPLY = {
  0: 'succeeded',
  1: 'general SOCKS server failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

/**
 * Buffered exact-length reads over a socket in flowing mode. Whatever arrives
 * after the handshake is pushed back so the caller's protocol sees a clean
 * stream -- a SOCKS server may legally coalesce its reply with the first bytes
 * from the far end.
 */
function reader(socket) {
  let buf = Buffer.alloc(0);
  let want = 0, resolve = null, reject = null;

  const settle = () => {
    if (!resolve || buf.length < want) return;
    const out = buf.subarray(0, want);
    buf = buf.subarray(want);
    const done = resolve;
    resolve = reject = null;
    want = 0;
    done(out);
  };
  const onData = c => { buf = Buffer.concat([buf, c]); settle(); };
  const onError = e => { const fail = reject; resolve = reject = null; fail?.(e); };
  const onClose = () => onError(new Error('socks5: server closed the connection'));

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  return {
    read: n => new Promise((res, rej) => { want = n; resolve = res; reject = rej; settle(); }),
    release: () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (buf.length) socket.unshift(buf);
    },
  };
}

const str = s => {
  const b = Buffer.from(String(s), 'utf8');
  if (b.length > 255) throw new Error('socks5: credential longer than 255 bytes');
  return b;
};

/**
 * Open a tunnel through `proxy` ({ host, port, user, pass }) to host:port.
 * Resolves with a connected socket carrying the tunnelled stream.
 */
export function socks5Connect(proxy, host, port, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error(`socks5: timed out talking to ${proxy.host}:${proxy.port}`));
    });
    socket.once('error', reject);

    socket.once('connect', async () => {
      const io = reader(socket);
      try {
        // Offer user/pass first; a proxy that wants no auth can still pick none.
        const methods = proxy.user ? [AUTH_USERPASS, AUTH_NONE] : [AUTH_NONE];
        socket.write(Buffer.from([V5, methods.length, ...methods]));

        const greeting = await io.read(2);
        if (greeting[0] !== V5) throw new Error('socks5: not a SOCKS5 server');
        if (greeting[1] === AUTH_NONE_ACCEPTABLE) {
          throw new Error('socks5: server rejected every auth method offered');
        }
        if (greeting[1] === AUTH_USERPASS) {
          if (!proxy.user) throw new Error('socks5: server wants a password but none is configured');
          const u = str(proxy.user), p = str(proxy.pass ?? '');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          const auth = await io.read(2);
          // Status is 0 on success; anything else means the login was refused.
          if (auth[1] !== 0x00) throw new Error('socks5: username/password rejected');
        } else if (greeting[1] !== AUTH_NONE) {
          throw new Error(`socks5: unsupported auth method 0x${greeting[1].toString(16)}`);
        }

        const name = str(host);
        socket.write(Buffer.concat([
          Buffer.from([V5, CMD_CONNECT, 0x00, ATYP_DOMAIN, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xFF, port & 0xFF]),
        ]));

        const head = await io.read(4);
        if (head[1] !== 0x00) {
          throw new Error(`socks5: ${REPLY[head[1]] ?? `reply 0x${head[1].toString(16)}`}`);
        }
        // Consume the bound address so it does not leak into the HTTP stream.
        if (head[3] === ATYP_IPV4) await io.read(4 + 2);
        else if (head[3] === ATYP_IPV6) await io.read(16 + 2);
        else if (head[3] === ATYP_DOMAIN) {
          const len = await io.read(1);
          await io.read(len[0] + 2);
        } else throw new Error('socks5: unknown address type in reply');

        io.release();
        socket.setTimeout(0);
        socket.removeListener('error', reject);
        resolve(socket);
      } catch (e) {
        io.release();
        socket.destroy();
        reject(e);
      }
    });
  });
}
