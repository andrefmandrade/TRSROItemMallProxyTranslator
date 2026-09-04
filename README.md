# TRSRO Mall Translator

Translates the **Item Mall** of the Turkish Silkroad Online client (TRSRO) into English
while you play — **without ever changing a price**.

The mall is not part of `Media.pk2`. It is a webmall: the client opens an embedded browser
and loads the mall as a website, so its text is served by the server, not read from the
game files. No archive edit can translate it. This tool sits in front of that one website
and rewrites the visible text on the way through.

```
sro_client (embedded IE)  ->  this proxy (translates)  ->  mall.gamegami.com
```

## Use it

1. Download `trsro-mall-translator.exe` and put it in a folder of its own.
2. Run it. Leave the window open while you play.
3. Point Windows at it, once:
   `inetcpl.cpl` → **Connections** → **LAN settings** → **Use automatic configuration script**
   Address: `http://127.0.0.1:8080/proxy.pac`
4. Open the Item Mall in game.

The auto-config script is deliberate: it sends **only** `mall.gamegami.com` through the
proxy and everything else stays direct, so your browser, Discord and the game itself are
untouched. Setting a global proxy instead will break other applications.

To stop using it, clear that same checkbox. Nothing else on your system is modified.

## It will not touch your money

This runs in front of a shop that takes real payment, so the safety is structural, not a
promise:

- Only text **between tags** is rewritten. Attributes — `package_id`, `href`, `onclick` —
  are never seen by the translator. The single exception is the `value=` of a submit
  button, which is a visible label.
- `<script>` and `<style>` bodies are removed before the text walk and put back after.
- **Any chunk whose numbers came out different is discarded** and the original is served.
  Prices, Silk balances and level requirements cannot move. `src/values.mjs` is that check.
- A failed `GET` may be retried. A `POST` never is — a POST is a purchase, and replaying
  one could buy the item twice. A failed purchase stays failed and is printed.

## Translate it yourself

On first run the tool writes its dictionaries to `config/dict/` beside the executable and
loads them from there afterwards. They are plain JSON, `"turkish": "english"`:

```json
{
  "Satın Al": "Buy",
  "Kullanım kısıtlaması yoktur.": "There are no usage restrictions."
}
```

Edit them and restart — no rebuild, no toolchain. Want the mall in Spanish, Portuguese or
anything else? Replace the values. **Your edits are never overwritten:** a newer version of
the executable only _adds_ keys you do not have yet, so an upgrade simply shows you what is
new, in your own file, ready to translate.

One consequence: to leave a string in Turkish on purpose, map it to the Turkish text itself
rather than deleting the line. A deleted key is treated as missing and gets seeded again.

`untranslated.json` lists text the dictionary did not touch, so you can see what is left.
Run with `CAPTURE=1` to also save the pages themselves into `captures/`, then
`npm run coverage` to measure.

## Several clients on different proxies

Skip this unless you run bots on proxies.

The mall must leave from the **same IP as that client's game session**, or the mall refuses
it — which is why the mall often fails to open while a bot is proxied: the game goes out
through the proxy and the mall goes out on your real IP.

Windows' proxy setting is per user, so one setting serves every client and cannot be told
apart. So the routing is discovered instead, from the bots themselves:

```
sro_client --loopback--> phBot listener --outbound--> the proxy that client uses
```

Put the proxies you use in `config/proxies.json`, one per line, in whichever shape you
copied them:

```json
["1.2.3.4:1080", "1.2.3.4:1080@user:password", "http://1.2.3.4:8080"]
```

SOCKS5 is assumed; `http://` marks an HTTP proxy, which needs no tunnel and is the better
choice here since the mall is plain HTTP. A password may contain `@` and `:` — the first of
each is the separator.

That file is also an **allowlist**, and that matters: a bot running _without_ a proxy has
the game server as its only outbound connection, and leaving it unlisted is what stops mall
traffic being sent there. Anything unlisted simply goes out directly, which is the correct
answer for an unproxied client anyway.

Check the pairing before trusting it:

```sh
npm run routes          # or: trsro-mall-translator.exe --routes
```

## Two of the mall's servers are dead — that is not this tool

`mall.gamegami.com` resolves to three addresses. Measured 2026-09-03, only `94.199.103.38`
answers; `.168` and `.78` complete the TCP handshake and then never send a byte. DNS hands
out all three in rotation and nothing in Node fails over between them, so roughly two
connections in three used to hang until they timed out — which looks exactly like the mall
randomly breaking, or randomly being slow.

This tool probes the addresses at startup, parks the silent ones, and fails over per
request. The startup line tells you what it found:

```
mall hosts : 1/3 answering  using 94.199.103.38  |  silent: 94.199.103.78, 94.199.103.168
```

## From source

Windows only — the routing reads `netstat` and `tasklist`. No runtime dependencies.

```sh
npm start           # run the proxy
npm test            # translator, routing and SOCKS5 tests
npm run routes      # show which proxy each running client would use
npm run build       # build the single-file exe (needs esbuild + postject, dev only)
```

Environment: `PORT` (8080), `CAPTURE=1`, `MAX_SOCKETS` (8), `ANSWER_TIMEOUT` (8000ms).

Layout:

|                     |                                                             |
| ------------------- | ----------------------------------------------------------- |
| `src/translate.mjs` | the rewriting itself, and the dictionary loader             |
| `src/values.mjs`    | the number guard — the reason prices cannot move            |
| `src/route.mjs`     | discovers which proxy each client's bot uses                |
| `src/socks5.mjs`    | SOCKS5 client (RFC 1928 + 1929), hand-rolled, no dependency |
| `src/host.mjs`      | picks a mall address that actually answers                  |
| `dict/`             | the shipped dictionaries, embedded into the exe             |

## Credits and provenance

The English wording comes from Joymax's own iSRO client string tables, matched to the
Turkish strings by ID and by exact text — the same approach as the
[Media.pk2 translation](https://github.com/) this grew out of, which is where the
dictionary generators live. Wording that exists only in the mall was translated by hand.

All game text, item names and artwork remain the property of Joymax / Gamegami. The MIT
licence below covers this tool's code, not the game's content.

## Licence

MIT — see `LICENSE`.
