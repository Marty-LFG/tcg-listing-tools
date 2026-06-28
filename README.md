# TCG eBay Listing Tools

Vite-served eBay listing builders for trading cards (Pokémon, Magic, Star Wars:
Unlimited, Riftbound) plus **LEGO sets** and **Funko Pop! vinyl**. The Vite dev
server proxies the data APIs so the browser never hits CORS, and all API keys stay
server-side (in the proxy config, never shipped to the client).

## Run

```bash
pnpm install
cp .env.example .env   # all keys optional — Riftbound works keyless; Scrydex adds pricing
pnpm dev
```

Vite opens the landing page. Pick a builder.

## How it works

- `/api/swu/*`  is proxied to `https://api.swu-db.com/*`  (no auth)
- `/api/rb/*`   is proxied to `https://api.scrydex.com/riftbound/v1/*`, with
  `X-Api-Key` / `X-Team-ID` injected from `.env` (optional — Riftbound pricing only)
- `/api/rbs/*`  is proxied to `https://riftscribe.gg/api/*`  (no auth — keyless Riftbound data)
- `/api/mtg/*`  is proxied to `https://api.scryfall.com/*`  (no auth)
- `/api/pkm/*`  is proxied to `https://api.pokemontcg.io/v2/*`  (no auth)
- `/api/lego/rebrickable/*` → Rebrickable, `/api/lego/brickset/*` → Brickset
  (key injected), `/api/lego/bricklink/*` → BrickLink (OAuth1-signed middleware)
- `/api/ebay/*` → eBay (OAuth2 app-token middleware) for Funko price comps &
  item-specifics

The tools call those relative paths, so everything is same-origin — no CORS,
no key in the browser. Edit the proxy targets/headers in `vite.config.js`.

## Notes

- Riftbound covers all four sets (Origins, Proving Grounds, Spiritforged, Unleashed)
  with no key — via baked offline data (`data/riftbound.json`, rebuilt with
  `node scripts/build-riftbound-data.mjs`) or the live keyless Riftscribe source. eBay
  supplies AUD price comps. Scrydex is optional and only adds live market price + a trend
  graph. Pick the source in the builder's "Data source" dropdown.
- SWU is entirely live via swu-db; Base URL is preset to `/api/swu`.
- Both builders always allow manual field entry; the preview builds regardless.

## Run on your home server (LAN access)

The dev server already binds to all interfaces (`host: true`, port `5273`).

```bash
pnpm install
cp .env.example .env     # optional keys — Riftbound works with no key
pnpm dev
```

Vite prints a **Network:** URL like `http://192.168.1.50:5273/`. Anyone on the
LAN opens that. Because your server has a fixed IP, the URL is stable.

Make it permanent + survive reboots/crashes — either:

- **systemd** (Linux): edit and install `tcg-tools.service` (instructions in the file), or
- **Windows service** (NSSM): see `scripts/WINDOWS_SERVICE.md`, or
- **pm2**: `pm2 start "pnpm dev" --name tcg-tools && pm2 save && pm2 startup`

Open the port on the server's firewall, e.g. `sudo ufw allow 5273/tcp`.

Optional nicety: give it a name instead of an IP. Add a line to each client's
hosts file (`192.168.1.50  cards.lan`) or a record in your router/Pi-hole DNS,
then browse to `http://cards.lan:5273`. If you use a hostname, also set
`server.allowedHosts: ['cards.lan']` in `vite.config.js`.

### Heads-up before exposing it
- This is Vite's **dev** server. Fine for a trusted home LAN; do **not** expose
  it to the public internet.
- Everyone on the LAN shares your **Scrydex** quota (the key stays server-side
  in `.env`, never sent to browsers — but lookups spend your credits).
- `/api/img` fetches arbitrary URLs server-side. Harmless on a trusted LAN;
  don't port-forward it.

## Shipping labels → AUSPRINT PRO (direct printing)

The **Shipping Label Maker** (`shipping-label.html`) can print straight to the
**AUSPRINT PRO** Wi-Fi thermal printer (a rebadged Rongta RP4xx, TSPL) with no
vendor app and nothing to install — it talks to the printer's raw `9100` socket
from the dev server (`/api/print` → `lib/labelprint.mjs`).

Setup:

1. **Find the printer's IP.** On your router's admin page, look at the DHCP client
   list — the AUSPRINT is the device that answers on **port 9100 only** (no web
   page). Set a **DHCP reservation** for it so the IP never changes.
2. **Configure it.** In `.env` set `LABEL_PRINTER_IP=` to that address (see the
   `LABEL_PRINTER_*` block in `.env.example` for the optional knobs: dpi, label
   size, gap, placement offset, darkness, invert). Restart `pnpm dev`.
3. **Use it.** Open the Shipping Label Maker — the **🖨 Print** button enables once
   the printer is found. It prints at whichever **label size is selected** (50×30 /
   100×50), so pick the size matching the stock you've loaded. It prints the current
   label plus any staged batch. Tick **Auto-print** to print each label automatically
   as it settles / is added.

Calibration (one-off, against a real label): use the bundled harness to sanity-check
the connection and tune placement —

```bash
node scripts/labeltest.mjs            # sends a TSPL test label to 192.168.4.220:9100
node scripts/labeltest.mjs --lang self  # prints the printer's own config page
```

If a printed address sits in the wrong spot, nudge `LABEL_PRINTER_OFFX_MM` /
`OFFY_MM`; if it's faint, raise `LABEL_PRINTER_DENSITY`; if it prints as a
photo-negative, set `LABEL_PRINTER_INVERT=true`. The printer is on Wi-Fi on the
same LAN as the dev-server host, so the host does the printing regardless of which
LAN client opened the tool.

## Working on this project (handoff)

If you're an AI coding agent or a new developer picking this up, start with
**`AGENTS.md`** — it covers the architecture, the invariants you must not break
(the proxies are dev-server-only!), how each builder is structured, and common
tasks. API endpoints and response schemas are in **`docs/DATA_SOURCES.md`**.
