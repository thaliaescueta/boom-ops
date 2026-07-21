# Migration & Channel Connections — Analysis

_Prepared from the Boom Ops dashboards (`public/migration.html`, `public/weekly-report.html`) and the client register (`data/clients.json`). Snapshot date: reporting window Feb 17–24, 2026._

This document explains how Boom migrates clients onto the platform, the role of the two
channel managers (**Rentals United** and **NextPax**), the recurring channel-connection
problems seen in the data, their likely root causes, and a **triage playbook** — for each
common failure, "what would you check first."

---

## 1. What "migration" and "channels" mean here

When a property manager signs with Boom, their listings and reservations have to be moved
off their previous PMS/channel manager (Avantio, Optima, Streamline, etc.) and re-connected
to the OTAs (**Airbnb, Booking.com/"BDC", Expedia, VRBO, Hopper**) so that calendars, rates,
reservations and guest messages sync through Boom.

Boom does **not** connect to every OTA directly. It connects through a **channel manager (CM)**
that sits between Boom and the OTAs:

- **Rentals United (RU)** — the primary CM. Used for the larger / multi-channel migrations.
  **VRBO and Expedia connections go exclusively through RU** in the data.
- **NextPax (NP)** — the secondary CM. Used for Airbnb + Booking.com migrations. No Expedia
  or VRBO seen through NextPax.

A "migration channel" is therefore one client's connection to one OTA, routed through RU or NP.
A single migration can create dozens or hundreds of these connections at once.

---

## 2. Completed migrations — RU vs NextPax (18 migrations)

| Channel Manager | Migrations | Airbnb | BDC | Expedia | Total connections |
|---|---|---|---|---|---|
| **Rentals United (RU)** | 10 | 568 | 390 | 81 | **1,039** |
| **NextPax (NP)** | 7 | 164 | 150 | 0 | **314** |
| None (direct) | 1 | 0 | 0 | 0 | 0 |
| **Total** | **18** | **732** | **540** | **81** | **1,353** |

**Reading the split:**
- RU carries ~77% of all migrated connections and every Expedia + VRBO connection.
- NextPax is used only for Airbnb + BDC — never the more complex channels.
- The largest single migrations (Smith & Adams 336, Fidalsa 179, Property Rental Club 171,
  2nd Homes 148) all went through **RU**. RU is the path for high-volume, multi-OTA clients.

**Implication for issue patterns:** because VRBO and Expedia only exist on RU, every
VRBO/Expedia problem is by definition an RU problem. NextPax issues cluster on Airbnb/BDC
sync and mapping.

---

## 3. Channel-connection issues, grouped by root cause

Issues pulled from active migrations, the weekly issue log, and client notes. Grouped by the
underlying cause rather than the symptom, because the same root cause shows up as many symptoms.

### A. Credentials & OTA access _(the client hasn't granted / linked access)_
- Expedia account access not granted by client (Happiness) — blocks go-live.
- Airbnb credentials needed / fixed before migration (Happiness).
- `mkoshkerman` Airbnb account not syncing (Furnished Club) — one account in a multi-account
  client never linked.
- **Cause:** the OTA account was never connected in the extranet, the connection request
  wasn't accepted, or credentials/API token expired. This is the #1 pre-migration blocker and
  it is almost always **client-side**.

### B. Listing mapping _(connected, but wrong listing ↔ property link)_
- Booking.com listing mapped to wrong property (Map Short Stays).
- BDC listing mapping / mapping-removal needed (Eden Villas, Map Short Stays).
- **Cause:** the CM's listing ID is bound to the wrong Boom property ID, or a stale mapping was
  never removed. Produces wrong details/rates on the live channel.

### C. Sync / connection state _(mapped, but data stops flowing)_
- Reservation sync broken after channel stop/start — fails to re-sync on reactivation,
  confirmed **double-booking risk**.
- Marriott reservation via RU not appearing in Boom (Aliyahhomes) — client managing manually.
- Reservations not syncing after channel stop/start (recurring, multiple clients).
- **Cause:** webhook/polling not re-subscribed after the channel was toggled, or the CM→Boom
  sync job silently failing. This is the highest-risk category — it causes double bookings.

### D. Rate & pricing push _(syncs, but the wrong number goes out)_
- VRBO price markup stopped working (MoreThan Stays, RU ticket #344585) — margin dropped.
- LOS (length-of-stay) discounts not working on BDC (Fidalsa).
- Airbnb vs BDC rate discrepancy — channel commission treated differently (Fidalsa).
- Expedia pricing mismatch — rates pushed ≠ configured rates.
- Pricing API returning 500 errors (Eden Villas) — blocks *all* rate management.
- Manual price overrides wiped during migration (Verano, dev #13575).
- **Cause:** per-channel markup/commission rules mis-applied, rate-plan mapping incomplete, or
  the pricing service erroring. Financial impact — either margin loss or overpricing.

### E. Messaging & notifications _(channel connected, guest comms broken)_
- VRBO guest messages not received through Boom inbox.
- Mobile notifications not firing on Airbnb & BDC (Furnished Club).
- Auto-messages / WhatsApp automations not sending (Furnished Club, Smith & Adams).
- BDC message delivery variance — inconsistent timing (BizFlats).
- WhatsApp template not showing in selector (Smith & Adams).
- **Cause:** channel messaging webhook not subscribed, notification service down, or (WhatsApp)
  template not approved / not synced from Meta Business.

### F. Payments & financials
- BDC payment showing unpaid despite receipt (Map Short Stays, Smith & Adams).
- Payment balance showing 0 on active bookings.
- VAT double calculation / tax calculated twice (Port City Haifa, Fidalsa, Aliyahhomes).
- Processing fee cannot be removed (MoreThan Stays).
- **Cause:** OTA-collect vs owner-collect payment model mis-configured, and tax formula config
  (accommodation tax vs cleaning VAT combined). Compliance-sensitive — Fidalsa has been fined.

### G. Migration data integrity _(one-time import problems)_
- Duplicate reservations (Smith & Adams, Fidalsa) — import created doubles.
- Revenue Analytics showing 0 occupancy/ADR/income (Smith & Adams) — historical data not mapped.
- Price overrides wiped on migration (Verano #13575).
- Wrong property addresses post-import (SignatureServiced).
- **Cause:** the reservation/import job's dedup key or field mapping was wrong. Shows up
  *immediately after* migration, not during steady state.

### H. Dev-blocked connections _(needs engineering, not ops)_
- **Fidalsa VRBO** → dev ticket **#14200** (DEV PENDING).
- **Smith & Adams VRBO** → dev ticket **#14328** (DEV PENDING).
- Guest portal payment-required bug → **#13655**; Finnish translation/images → **#13629**.
- **Cause:** platform-side gaps; ops can't resolve, they escalate and track. Note these tickets
  live in the `designedvr/designedvr` engineering repo, not in `boom-ops`.

**Weekly issue distribution (this reporting week, 56 new + 22 carried over):**
Channel Manager/OTA (6), CRM/Messaging (8), Calendar & Availability (6), Pricing & Financials (5),
Integrations/API (4), Payments (3), Reporting (3), Rentals United/VRBO (2).

---

## 4. The patterns worth calling out

1. **VRBO is the problem child, and it's always RU.** VRBO shows up as: connection not live
   (Central Management), dev-blocked (Fidalsa #14200, Smith & Adams #14328), markup broken
   (MoreThan Stays), messages not received. VRBO connects only through RU and is consistently
   the last/hardest channel to bring live.
2. **The dangerous failures are silent sync failures (Category C).** Mapping and credential
   problems are visible and annoying; a reservation that fails to sync after a channel
   stop/start causes a **double booking** — the highest-cost operational failure.
3. **Migration-data bugs (Category G) look like product bugs but aren't.** "Revenue shows 0",
   "duplicate reservations", "price overrides gone" all trace back to the import, and appear
   right after cutover. Knowing the difference saves triage time.
4. **NextPax vs RU changes the suspect list.** If it's an Expedia or VRBO issue, it can only be
   RU. If it's Airbnb/BDC and the client is on NextPax, RU config is irrelevant.

---

## 5. Interview triage playbook — "if this happens, what do you check first?"

A tight, ordered checklist per symptom. The pattern for all of them: **isolate the layer**
(client/OTA → channel manager → Boom) before touching config.

### "A reservation isn't showing up in Boom" (e.g. Marriott/RU)
1. **Where does it exist?** Confirm it's live in the OTA extranet and in the channel manager
   (RU/NP). This tells you which hop is broken.
2. **Channel connection status** in the CM — is the connection active, or did it drop after a
   stop/start? Check the **last successful sync timestamp**.
3. **Mapping** — is that listing mapped to the right Boom property? An unmapped listing's
   reservations have nowhere to land.
4. **Sync logs / webhook** — did the CM→Boom event fire and error? Re-trigger a manual sync.
5. **Escalate** only after confirming the reservation is in the CM but not crossing into Boom —
   that's a Boom-side ingestion bug, not ops config.
   > _Why this order: it's a double-booking risk, so first prove whether Boom knows about the
   > booking at all before assuming it's a display bug._

### "The channel won't connect / listing isn't going live" (Airbnb, Expedia, VRBO)
1. **Credentials & access first** — has the client granted access / accepted the connection
   request in the OTA extranet? (Expedia & Airbnb access are the usual culprits.)
2. **Right channel manager?** VRBO/Expedia must go through **RU**; if someone tried NextPax,
   that's the problem.
3. **Mapping** — listing created and mapped in the CM to the correct Boom property.
4. **Is it dev-blocked?** VRBO especially — check for an open dev ticket (e.g. #14200, #14328)
   before burning time on config.

### "Rates/prices are wrong on a channel" (markup, LOS, discrepancy)
1. **Compare the three numbers:** rate configured in Boom → rate the CM received → rate live on
   the OTA. The mismatch's location tells you the layer.
2. **Per-channel rules** — markup % and commission model differ by channel (Airbnb vs BDC).
   Confirm the channel-specific markup/commission setting.
3. **Rate plan mapping** — is the Boom rate plan mapped to the channel's rate plan (LOS
   discounts, non-refundable plans often aren't)?
4. **Pricing API health** — if rate management is fully dead, check for 500s from the pricing
   API before assuming config.

### "Guest messages / notifications aren't coming through"
1. **Which channel + which direction?** Inbound (guest→Boom) vs outbound (auto-message→guest)
   narrows it fast.
2. **Messaging webhook** for that channel — subscribed and firing? (VRBO inbound is a known gap.)
3. **WhatsApp specifically** — template approved in Meta Business and synced into the selector?
4. **Notification service** — is it the channel, or is the whole notification/push layer down
   (mobile notifications failing across Airbnb *and* BDC points to the service, not one channel).

### "Payments show unpaid / balance is 0 / tax is doubled"
1. **Payment model** — is the channel OTA-collect or owner-collect? Wrong model = wrong balance.
2. **Reconcile against the OTA** — does the OTA show it paid? If yes and Boom shows unpaid, it's
   a sync/status-mapping issue.
3. **Tax formula config** — for double-tax, check whether cleaning VAT is wrongly folded into
   the accommodation-tax formula (Fidalsa's exact issue). Compliance-sensitive — treat as urgent.

### "Something broke right after migration" (duplicates, 0 revenue, overrides gone)
1. **Timing check** — did it start at cutover? That points at the **import**, not the product.
2. **Import logs** — duplicates → dedup key; 0 revenue → historical reservations not mapped;
   overrides gone → price fields not carried over (dev #13575).
3. **Scope** — one property or all? All properties = systemic import mapping; one = data-specific.
4. Distinguish "import artifact" from "live product bug" before escalating — they route to
   different owners.

### General principle to state in an interview
> **Isolate the layer before you touch anything.** Every channel issue lives in one of three
> hops: the OTA/client side, the channel manager (RU/NextPax), or Boom. Find which hop the data
> last looked correct in, and you've found the layer. Only then check config, and only then
> escalate to engineering — with the evidence of which hop failed.

---

## 6. Sources
- `public/migration.html` — active migration tracker (`CHANNELS`) + completed log (`COMPLETED`).
- `public/weekly-report.html` — categorized weekly issue log with RU/NextPax/dev-ticket tags.
- `data/clients.json` — per-client status and issue notes.
- Referenced engineering tickets (#13575, #13629, #13655, #14200, #14328) live in the external
  `designedvr/designedvr` repo and were not accessible from this session.
