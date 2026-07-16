# Pending CS — Daily Report Bot

Every morning the bot reads the open GitHub tickets whose **Status = Pending CS**
on the **DEV Team Planning** Projects v2 board (org `designedvr`), groups them by
assignee, and posts a clear urgency table to the **#boom-ninjas** Slack channel so
the team can keep their queue under control.

> Because "Pending CS" is a Projects v2 single-select **Status** field (not a
> label), the tickets are fetched through GitHub's **GraphQL** Projects v2 API.

The report is posted as a **Slack Canvas table** in **#boom-ninjas** — a real
grid with clickable ticket links, updated **in place** every morning (one canvas,
no channel spam). Set `PENDING_CS_OUTPUT=message` to fall back to a chat message
instead.

It's a **per-agent table** — one row per assignee, counting only tickets that
have been **open longer than 24 hours**:

- **Agent** — the assignee, @mentioned
- **# open >24h** — how many of their Pending CS tickets have been aging past 24h
- **Tickets** — clickable links to those tickets (each shows its age)

Rows are sorted by count (most aging tickets first, 👑). Colour tracks the count
so it's obvious who needs to act:

| Tier | Marker | Trigger |
|------|--------|---------|
| Critical | 🔴 | 4+ tickets open >24h |
| High | 🟠 | 2–3 tickets open >24h |
| Medium | 🟡 | 1 ticket open >24h |

Tickets with no assignee are grouped into an **Unassigned** row. The 24h window
is configurable via `PENDING_CS_MIN_AGE_HOURS`. Age is measured from ticket
creation by default; set `PENDING_CS_AGE_FROM=assignment` to use the assignment
date instead.

## Pieces

| File | Role |
|------|------|
| `lib/pending-cs.js` | Fetch (GitHub Projects v2 GraphQL), aggregate, tier, format & post (Slack). Pure helpers are unit-testable. |
| `data/cs-team.json` | Maps GitHub login → Slack member id so mentions notify the real person. |
| `scripts/send-pending-cs.js` | Standalone one-shot runner (used by GitHub Actions / any cron). |
| `.github/workflows/pending-cs-daily.yml` | Serverless daily schedule (GitHub Actions). |
| `public/pending-cs.html` | Portal preview page (`/pending-cs`) with "Load live" + "Send to Slack now" (admin). |
| `server.js` | `node-cron` 9 AM schedule + `/api/pending-cs` (preview) and `/api/pending-cs/send` (manual). |

## How it runs — pick ONE

The daily post can be driven two ways. **Enable only one**, or the report posts twice.

### Option A — GitHub Actions (recommended, no server needed)
`.github/workflows/pending-cs-daily.yml` runs on a schedule. Add these to the
repo (**Settings → Secrets and variables → Actions**):
- Secret `PENDING_CS_GITHUB_TOKEN` — PAT with Projects + Issues read on `designedvr`.
- Secret `SLACK_BOT_TOKEN` **or** `SLACK_WEBHOOK_URL`.
- (optional) Variable `SLACK_CS_CHANNEL` — defaults to #boom-ninjas.

It fires at 06:00 **and** 07:00 UTC and uses an hour guard so it posts exactly
once at 09:00 Israel time year-round (handles daylight saving). Use the **Run
workflow** button for an immediate test. Do **not** also set the Railway env
vars below (or set `PENDING_CS_ENABLED=false` there) to avoid double posts.

### Option B — Railway (the existing portal server)
The portal's built-in `node-cron` scheduler auto-enables once GitHub + Slack env
vars are set (see table below). This keeps the `/pending-cs` preview page and
the **Send to #boom-ninjas** button live, but depends on the server staying up.

> The live fetch scans the whole DEV Team planning board (~8.8k items, no
> server-side field filter in the Projects v2 API), so a run takes ~2 minutes.
> Fine for a daily job; the portal page therefore loads sample data by default
> and fetches live only when you click **Load live**.

## Configuration (Railway env vars)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `GITHUB_TOKEN` (or `GH_TOKEN`) | yes | — | Needs Projects (read) + Issues/Contents (read). Classic PAT: `read:project` + `repo`. |
| `GITHUB_PROJECT_OWNER` | no | `designedvr` | Org/user that owns the board. |
| `GITHUB_PROJECT_NUMBER` | no | `2` | The number in the board URL: `github.com/orgs/designedvr/projects/2` (DEV Team Planning). |
| `GITHUB_PROJECT_OWNER_TYPE` | no | auto | `org` or `user`; blank auto-detects. |
| `GITHUB_STATUS_FIELD` | no | `Status` | Single-select field name on the board. |
| `PENDING_CS_STATUS` | no | `Pending CS` | The status option to report on. |
| `PENDING_CS_AGE_FROM` | no | `assignment` | `assignment` (uses the assign event) or `created`. |
| `SLACK_BOT_TOKEN` | yes | — | `xoxb-…`. Scopes: `canvases:write`, `channels:read` (+ `chat:write` for message mode). The bot must be **invited to #boom-ninjas**. |
| `SLACK_WEBHOOK_URL` | — | — | Only used by `PENDING_CS_OUTPUT=message` fallback. |
| `SLACK_CS_CHANNEL` | no | `C09JYCQ2DLG` (#boom-ninjas) | Channel whose canvas is updated. |
| `PENDING_CS_OUTPUT` | no | `canvas` when a bot token is set | `canvas` (channel canvas) or `message`. |
| `PENDING_CS_CANVAS_ID` | no | `F0BHMFKN51B` | The #boom-ninjas canvas edited daily. With it set, the job needs only `canvases:write` (no `channels:read`). |
| `PENDING_CS_TZ` | no | `Asia/Jerusalem` | Timezone for the schedule (9 AM Israel time). |
| `PENDING_CS_SCHEDULE` | no | `0 9 * * *` | Cron expression (9:00 AM). |
| `PENDING_CS_ENABLED` | no | auto | `true`/`false` to force the scheduler on/off. Auto-on when GitHub + Slack are both set. |
| `PENDING_CS_CRIT_DAYS` / `_HIGH_DAYS` / `_MED_DAYS` | no | 7 / 4 / 2 | Age thresholds. |
| `PENDING_CS_CRIT_COUNT` / `_HIGH_COUNT` / `_MED_COUNT` | no | 8 / 5 / 2 | Count thresholds. |

\* Provide **either** `SLACK_BOT_TOKEN` or `SLACK_WEBHOOK_URL`.

## Finishing setup

1. Set the env vars above in Railway — at minimum `GITHUB_TOKEN`,
   `GITHUB_PROJECT_NUMBER`, and a Slack credential. Find the project number in
   the board URL (`github.com/orgs/designedvr/projects/<N>`).
2. **Fix `data/cs-team.json`** — the Slack ids are the live #boom-ninjas members,
   but the `githubLogin` values are placeholders. Replace each with the
   teammate's actual GitHub username so mentions line up with ticket assignees.
   Any assignee without an entry falls back to plain `@login` text (no ping).
3. Open **`/pending-cs`** in the portal to preview. Admins can hit
   **Send to #boom-ninjas** to post immediately without waiting for 9 AM.

Until GitHub is configured the preview page and API return **sample data** so
the portal always renders.
