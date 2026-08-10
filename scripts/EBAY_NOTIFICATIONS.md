# eBay push notifications — tunnel + endpoint runbook

Getting eBay to push sales at this box instead of us asking every ten minutes.

**Nothing here removes the poll.** Push makes discovery fast; the poll is what makes it correct.
eBay retries a delivery three times and then gives up, publishes no latency SLA, and silently disables
a destination that keeps failing — so the poll stays armed permanently and every rollback below is
just "stop pushing", never "stop working".

Order matters. eBay validates the endpoint at the moment you register it, and a failed validation
disables the destination rather than retrying.

---

## 0. What you need first

- A domain you control. Any registrar, any TLD — it only has to resolve.
- A Cloudflare account (free plan is enough).
- `EBAY_NOTIFY_VERIFICATION_TOKEN` and `EBAY_NOTIFY_DELETION_TOKEN` in `.env` on the server.
  32–80 chars, `A-Z a-z 0-9 _ -` only. Generate each with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"
  ```

The static IP on this line is deliberately **not** used. A tunnel means no inbound port, no firewall
rule, no certificate to renew, and it keeps working if the IP ever moves.

---

## 1. Put the domain on Cloudflare

Add the site in the Cloudflare dashboard and repoint the registrar's nameservers at the two it gives
you. Propagation is usually minutes and occasionally 24 hours — **start this first**, it gates
everything below.

Do **not** create an A record. The tunnel creates its own proxied CNAME in step 2.

---

## 2. Install cloudflared on ALCSERVER

Run on the server itself (192.168.4.200), not the dev box:

```bat
winget install --id Cloudflare.cloudflared
```

```bat
cloudflared tunnel login
```

```bat
cloudflared tunnel create tcg-tools
```

Note the tunnel UUID it prints, then point a hostname at it:

```bat
cloudflared tunnel route dns tcg-tools ebay-notify.YOURDOMAIN.com
```

Write `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <UUID>
credentials-file: C:\Users\<user>\.cloudflared\<UUID>.json
ingress:
  - hostname: ebay-notify.YOURDOMAIN.com
    path: ^/ebay/(notifications|account-deletion)$
    service: http://127.0.0.1:5274
  - service: http_status:404
```

The trailing `http_status:404` is the safety rail, and it is not optional: cloudflared itself refuses
anything outside those two paths, so even a mistyped hostname cannot reach the dev server on 5273.

> Check the `path` regex against your installed cloudflared — the ingress matching syntax has changed
> across releases. `cloudflared tunnel ingress validate` checks the file, and
> `cloudflared tunnel ingress url https://ebay-notify.YOURDOMAIN.com/api/status` shows which rule a URL
> would hit. That second one should resolve to the 404 rule, not the service.

Then install it as a service so it survives a reboot:

```bat
cloudflared service install
```

**Open no inbound firewall port.** The tunnel dials out. The existing rule for 5273 stays as it is and
gets no sibling — that is the entire point of choosing a tunnel over the static IP.

---

## 3. Arm the listener

Settings → **eBay push notifications**:

| Field | Value |
|---|---|
| Public endpoint | `https://ebay-notify.YOURDOMAIN.com/ebay/notifications` |
| Listener path | `/ebay/notifications` |
| Account-deletion path | `/ebay/account-deletion` |
| Bind host | `127.0.0.1` (the save is refused otherwise) |
| Bind port | `5274` |
| Receive push notifications | on |

The public endpoint is hashed **verbatim** into the challenge reply. A trailing slash, `http`, or a
path that differs from the listener path all produce a valid-looking hash that eBay rejects with no
diagnostic on either side, so the settings form refuses each of those on save.

---

## 4. Prove it before telling eBay it exists

This is the step that saves you a disabled destination. Both must return the **same** hash:

```bash
curl "http://127.0.0.1:5274/ebay/notifications?challenge_code=test123"
```

```bash
curl "https://ebay-notify.YOURDOMAIN.com/ebay/notifications?challenge_code=test123"
```

The first proves the listener is bound and hashing. The second proves DNS, the tunnel, TLS and the
ingress rules. If the first works and the second does not, the problem is cloudflared, not this app.

Confirm the tunnel is not exposing anything else — this must be a 404 with an empty body:

```bash
curl -i "https://ebay-notify.YOURDOMAIN.com/api/status"
```

And check the certificate chain with an external checker rather than a browser. Browsers cache
intermediates and will tell you a chain is fine when eBay's validator cannot complete it — the
best-attested real-world failure here is an incomplete chain, where eBay's call fails with *nothing in
your logs at all*, because the request never arrives.

`/api/status` also carries the listener under `jobs.ebay_notify`, and there is a probe
(`ebay-notify`) that does the loopback round-trip for you.

---

## 5. Register with eBay

Only after step 4 passes.

The account-deletion endpoint is configured in the **Developer Portal** (Application Keys →
Notifications), not through the API — the portal config is the compliance mechanism. Check what it
currently points at before changing it.

Notification destinations and subscriptions are created through the Notification API. That work lands
in the next phase; the endpoint being live and provably correct is what this runbook delivers.

---

## 6. Decide what a notification is allowed to DO

Receiving a notification and acting on one are separate settings on purpose. Settings → **eBay push
notifications** → *What a notification does*:

| Mode | What happens on a sale |
|---|---|
| `poll` | Runs the order poll straight away. The 🟢 SOLD alert, the stock decrement and the draft all happen seconds after checkout instead of up to ten minutes later. |
| `observe` | Reads the order back from eBay and writes down what was true. Ingests nothing, sends nothing, moves nothing. |
| `off` | Records the notification and looks at nothing. |

**`poll` is not a second pipeline, and that is the whole reason it is safe.** It calls the same
`runOrderPoll` the ten-minute timer calls, so every alert, dedupe, stock move and draft is the code
that has been carrying the store all along. Push changes only *when* it runs. If a bug ever appears
in poll mode, it is a bug the scheduled poll has too.

Two things are worth knowing before you turn it on.

**The cursor is held for an order eBay has not returned yet.** eBay's order service can announce a
sale a moment before `GetOrders` will serve it, and reacting two seconds later is exactly when that
gap is open. A push-triggered poll therefore names the order it was told about, and if that order
does not come back, `orders_cursor` does not move — otherwise the sale would fall outside every
future window and be lost rather than late. The next scheduled poll always drains and releases it, so
a hold cannot stick. You will see this in the log as *"cursor HELD so the next poll's window still
covers them"*, and it is routine rather than alarming.

**`observe` remains the way to measure before trusting.** It is what produced the case for poll mode
in the first place: six of six real notifications arrived ahead of the poll, a median of 364 seconds.
`GET /api/ebay-notify/observations?days=14` is that measurement, and it keeps working in poll mode —
`median_lead_over_poll_s` simply stops meaning "how far ahead of the schedule push was" and starts
meaning "how long from notification to order in hand", which should now read in seconds.

---

## Rollback — five levels, none needing a code change

0. **Settings → What a notification does: `observe`** (or `off`). Push keeps arriving and keeps being
   recorded; it just stops driving anything. The scheduled poll goes back to being the only thing
   that adopts an order, exactly as before. This is the first thing to reach for, because it changes
   behaviour without changing what you can see.
1. **Settings → Receive push notifications: off.** The listener unbinds, every timer stays armed,
   polling carries everything. Seconds, and reversible.
2. **Disable the eBay subscriptions** (disable, never delete — deleting loses the history and eBay
   reuses ids).
3. **`cloudflared service stop`.** Ingress dies. eBay retries three times, marks the destination down,
   and the health check says so. Polling covers the data throughout.
4. **Restore `poll_interval_min: 10`** if it was ever widened.

Nothing in any of these touches `orders_cursor`, the activation watermark, or a single order row.

---

## When something is wrong

| Symptom | Almost always |
|---|---|
| eBay refuses to create the destination | The challenge hash. Check the public endpoint matches the listener path exactly, no trailing slash, and the token is the one in `.env`. |
| eBay's validation call never appears in the logs | The TLS chain, or DNS not yet propagated. The request is not reaching the box. |
| Listener will not start | `jobs.ebay_notify.bind_error` in `/api/status`. Usually a malformed verification token, or a second instance already holding the port. |
| `sig_failures` climbing | Someone is POSTing at the endpoint, or the destination was registered against a different token. Signature failures never reach the database. |
| Notifications stop arriving | eBay disables a destination after repeated failures. Check the destination status; the poll will have been carrying orders the whole time. |
| Notifications arrive but Telegram still waits for the poll | `jobs.ebay_notify.react.mode` in `/api/status`. `observe` and `off` both record the sale and deliberately do nothing with it. |
| `cursor HELD` in the log after every sale | Normal if occasional: eBay announced an order it would not yet return. Constant means `GetOrders` is not returning orders it is notifying about — check `jobs.postsale.order_poll.last_run.awaiting`. |
| A sale alert fires twice | It cannot: `fireSaleAlert` dedupes on `orders.sale_alert_sent_at`, and the push poll and the scheduled poll share that row. If you genuinely see two, that is a bug in the poll, not in push. |
