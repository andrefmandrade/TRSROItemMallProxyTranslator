Translates the TRSRO Item Mall into English while you play.

The mall is not part of `Media.pk2` — the client opens an embedded browser and loads the
mall as a website, so its text comes from the server and no archive edit can change it.
This is a small local proxy that sits in front of that one website and rewrites the visible
text as the page loads. Nothing is installed and no game file is touched.

## What's new in v1.1.0

- Fixed a proxy address-parsing bug: a `scheme://host:port@user:pass` entry (a common way to
  paste a proxy) could have its host and login read backwards, silently sending the mall
  through the wrong address.
- Fixed HTTPS mall pages (the Avatar & Pet Mall preview, among others) picking a random one of
  the mall's three addresses on every load, including the two that never answer — that could
  hang the connection with no error at all. It now reuses the same known-good address the rest
  of the tool already tracks.
- Raised the default connection pool per proxy (`MAX_SOCKETS`) from 8 to 20 — an HTTP proxy has
  no per-connection handshake the way SOCKS5 does, so pages with lots of images load noticeably
  faster when routed through a proxy.
- ~20 more translated strings: the Avatar & Pet Mall list and preview screens, a few item
  descriptions, and the Silk purchase guide.

## Setup

1. Put `trsro-mall-translator.exe` in a folder of its own and run it. Leave the window open
   while you play.
2. Open Internet Options (`inetcpl.cpl`) → **Connections** → **LAN settings**
3. Tick **"Use automatic configuration script"** and enter:
   `http://127.0.0.1:8080/proxy.pac`
4. Open the Item Mall in game.

That setting sends **only** `mall.gamegami.com` through the tool — your browser, Discord and
the game itself are unaffected. Untick the box to turn it off. Nothing else is changed.

Windows only. On first run the tool writes a `config/` folder beside itself.

## Windows will warn you

The executable is not code-signed, so SmartScreen shows *"Windows protected your PC"*.
Click **More info → Run anyway**. If you would rather not take that on faith, the source is
public and the exe is Node plus this project's code — you can rebuild it yourself with
`npm run build` and compare.

**SHA-256**

```
ad53ae8db4397ba1530081aea466b83b9182283e5d0c084f2047c62dda3c4e88
```

Verify with `certutil -hashfile trsro-mall-translator.exe SHA256`.

## What is in it

- 2,517 strings and 12 patterns
- 2,242 of them taken straight from Joymax's own English client string tables
- The rest translated by hand: mall-only wording, purchase screens, tabs and buttons
- Item names, descriptions, "How to Use", restrictions, history and favorites

**It will not touch your money.** Only text between HTML tags is rewritten, never
attributes; `<script>` and `<style>` are excluded; and any text whose numbers came out
different is discarded so the original Turkish is shown instead. Prices, Silk balances and
level requirements cannot move. A failed `GET` may be retried, a `POST` never is — a POST is
a purchase, and replaying one could buy the item twice.

## Two of the mall's three servers are dead

`mall.gamegami.com` resolves to three addresses. Measured 2026-09-03, only
`94.199.103.38` answers; the other two complete the TCP handshake and then never send a
byte. DNS hands out all three in rotation, and a mall page pulls around 72 images, so on a
heavy tab a large share of requests used to stall — which is the mall freezing or refusing
to open, on a clean client too.

This tool probes the addresses at startup, parks the silent ones and fails over per
request. The startup line reports what it found.

## Translate it yourself

The dictionaries are written to `config/dict/` beside the executable and loaded from there.
They are plain JSON — edit and restart, no rebuild. Replace the values and you have the
mall in any language. Your edits are never overwritten: an update only adds keys you do not
have yet.

`untranslated.json` lists anything the dictionary did not touch.

## Running several clients on different proxies

Optional, and only relevant if you use proxies. The mall has to leave from the same IP as
that client's game session or it refuses the session — which is why the mall often will not
open while a bot is proxied. List your proxies in `config/proxies.json` and the tool sends
each client's mall traffic out through the proxy that client's own bot is using. Check the
pairing with `trsro-mall-translator.exe --routes` before trusting it.

Built with Node v22.22.3.
