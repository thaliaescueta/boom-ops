# NextPax / Switches — KPI & Measurement Framework

**Owner:** Thalia Escueta · **Sponsor:** Nitzan Afek · **Cadence:** bi-weekly to leadership
**Status:** proposal (v1) · **Source data:** Migrations dashboard (`public/migration.html`) + `data/clients.json`

---

## 1. Why this exists

The "Switches" project moves clients onto Boom from their previous system, either
**via NextPax (NP)** or **Rentals United (RU)** as the channel-manager path. Today we
run migrations, but we can't answer the questions leadership actually asks:

- Is the migration process getting **better or worse** over time?
- How many things **break** on each switch, and how bad are they?
- Do the issues we open ever get **closed**, or do they leak?
- How often do we have to **escalate to NextPax**?
- Do switched clients **stay** — or do we lose them right after migrating?

This document defines **what "success" means**, the **3–5 KPIs** we report bi-weekly,
and the **issue-reporting procedure** that makes those KPIs measurable.

### What "a successful switch" means

> A switch is **successful** when the client is fully live on all their channels
> **with zero unresolved Critical/High issues 14 days after go-live**, no escalation
> to NextPax was needed to complete it, and the client is still active 90 days later.

Every KPI below is a way of measuring one part of that sentence.

---

## 2. The KPIs

Five KPIs, each with a definition, data source, target, and the direction we want it
to move. All are computed from the standardized issue records defined in §4 plus the
migration list in the dashboard.

| # | KPI | Definition (formula) | Source | Target | Want |
|---|-----|----------------------|--------|--------|------|
| 1 | **Critical Issues per Switch** | `# Critical+High issues reported` ÷ `# switches` in the period | Issue labels (§4) | ≤ 1.0 | ↓ |
| 2 | **Clean-Switch Rate** | `# switches with 0 Critical/High issues open at go-live + 14d` ÷ `# switches` | Issues + migration date | ≥ 70% → 90% | ↑ |
| 3 | **Issue Full-Cycle Closure** | median days from issue **Reported → Verified/Closed**; and `% of migration issues still open > 7d` | Issue lifecycle (§4) | median ≤ 3d; <15% aging | ↓ |
| 4 | **Escalations to NextPax** | `# issues escalated to NextPax` ÷ `# NP switches` in the period | `escalated:nextpax` label | ↓ each period | ↓ |
| 5 | **Post-Switch Retention (anti-churn)** | `# clients still active 90d after switch` ÷ `# switches`; report churn/switch-backs as a count | `clients.json` status + migration date | ≥ 95% | ↑ |

**Why these five** — they map 1:1 to Nitzan's asks: critical-issue count (#1), churn/
switch-backs (#5), NextPax escalations (#4), plus the two that tell us whether the
*process* is improving: how clean each switch is (#2) and whether we actually close
what we open (#3).

### Supporting metrics (tracked, not headline)

Show these underneath the five when leadership wants detail:

- **Issue breakdown by category** — channel-sync / pricing-&-VAT / calendar / data-migration
  / messaging-automation / access-permissions. Tells us *where* switches break.
- **NP vs RU comparison** — same KPIs split by channel-manager path, to see if one path
  is materially cleaner than the other.
- **Time-to-Live** — days from migration start → fully live on all channels.
- **Issues per migrator** — for coaching, not leadership slides.

---

## 3. Baseline (from current dashboard snapshot, Feb 2026)

Illustrative starting numbers so we have something to trend against. These will be
restated precisely once the labeling procedure (§4) is applied to open issues.

- **Switches completed to date:** 18 total — **7 via NextPax**, 10 via RU, 1 direct.
- **Post-switch clients currently in "issues" status:** 5 of the recently migrated
  (Furnished Club, GuroomHolidayHomes, Smith & Adams, Fidalsa, Verano).
- **Example Critical/High issues open now:**
  - Verano — `#13575` price overrides **wiped during migration**; urgent calendar-block failure.
  - Smith & Adams — Revenue Analytics reading **0** across all active bookings (migration data).
  - Fidalsa — **compliance** check-in errors (client previously fined); VRBO email overdue **17+ days**.
  - Furnished Club — inbound notifications + auto-messages **not firing** post-switch.
- **Escalations already happening:** GuroomHolidayHomes 403 → escalated to Intercom;
  Fidalsa VRBO stuck 17+ days.
- **Churn:** 2 churned clients in `clients.json` (cost / moved to competitor) — neither
  yet attributed to a switch; attribution starts once §4 is in place.

---

## 4. Issue-reporting procedure (the "full-cycle" process)

**Problem today:** migration issues live as free text in per-client Slack channels and
dashboard notes. They can't be counted, categorized, aged, or proven closed — so KPIs
1–4 are impossible.

**Procedure:** every migration issue is logged as a **GitHub issue on the `designedvr`
board** (same board the Pending CS bot already reads) with a **consistent label set**.
This makes all five KPIs computable automatically.

### 4.1 Required labels on every migration issue

| Label | Purpose | Values |
|-------|---------|--------|
| `migration` | Marks it as a switch issue (KPI scope) | fixed |
| `client:<name>` | **The customer label** Nitzan asked for — one per client | e.g. `client:fidalsa` |
| `sev:*` | Severity → drives KPI 1 & 2 | `sev:critical`, `sev:high`, `sev:normal`, `sev:low` |
| `cm:*` | Channel-manager path | `cm:nextpax`, `cm:ru`, `cm:direct` |
| `cat:*` | Category → supporting breakdown | `cat:channel-sync`, `cat:pricing-vat`, `cat:calendar`, `cat:data-migration`, `cat:messaging`, `cat:access` |
| `escalated:nextpax` | Set when escalated to NextPax → KPI 4 | applied when escalated |

**Severity rubric** (so it's consistent across people):

- **Critical** — data loss, compliance exposure, bookings/revenue broken, client can't operate.
- **High** — a core channel/feature is down for the client but a workaround exists.
- **Normal** — a feature is degraded; not blocking daily operation.
- **Low** — cosmetic / nice-to-have.

### 4.2 Lifecycle (the "full cycle" Nitzan wants closed)

Track status on the board's single-select field so aging and closure are measurable:

```
Reported  →  In Progress  →  [Escalated: NextPax]  →  Fixed  →  Verified w/ client  →  Closed
```

- **Reported** timestamp starts KPI 3's clock.
- **Escalated: NextPax** (optional branch) increments KPI 4.
- **Verified w/ client** before **Closed** — closure isn't "we think it's fixed," it's
  "the client confirmed." This is what makes the cycle genuinely closed.

### 4.3 Definition of Done for a switch

A switch is only marked **complete** when: all channels live, **0 open `sev:critical`
or `sev:high`** issues, post-migration checklist sent, and client confirmed. Anything
short of that stays "in issues" and counts against the Clean-Switch Rate.

---

## 5. Bi-weekly leadership report

One page, same shape every fortnight so trends are obvious. Suggested layout:

1. **Headline strip** — the 5 KPIs as big numbers, each with the arrow vs. last period.
2. **This period** — # switches done (NP / RU), # issues opened by severity, # closed.
3. **Still open** — Critical/High issues aging > 7d, with client + owner + age.
4. **Escalations** — every issue sent to NextPax this period and its status.
5. **One insight** — what the data says about the process (e.g. "pricing/VAT is 40% of
   Critical issues on NP switches — root-cause the migration mapping").

### Automation path (optional, phase 2)

The Pending CS bot (`lib/pending-cs.js`) already reads the `designedvr` board via the
Projects v2 GraphQL API and posts a Slack canvas. The same machinery can generate this
report: filter issues to `migration`, group by `sev:*` / `client:*` / `escalated:*`,
compute the five KPIs, and post a **NP-Switches KPI canvas** every two weeks. That turns
this from a manual slide into a live, self-updating report. Wiring it up is a follow-up
once the labels in §4 exist and have a few weeks of data behind them.

---

## 6. Rollout

1. **Create the labels & board status values** in §4 on the `designedvr` board.
2. **Backfill** the currently-open migration issues (the §3 list) with labels so we
   start with a real baseline, not zero.
3. **Adopt the procedure** — from now on, no migration issue is "raised" until it's a
   labeled ticket. Slack stays for discussion; the ticket is the record.
4. **First report** at the next bi-weekly, even if partial, to lock in the cadence.
5. **Automate** (phase 2) once ~2–4 weeks of labeled data exist.
