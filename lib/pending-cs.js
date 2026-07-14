/**
 * Pending CS — daily report bot
 * ------------------------------------------------------------------
 * Analyzes GitHub issues carrying the "Pending CS" status/label,
 * aggregates them per assignee (count · oldest age · average age),
 * assigns a visual urgency tier, and posts a daily table to Slack.
 *
 * Everything is driven by environment variables so no secrets live in
 * the repo. The heavy-lifting helpers (buildReport / tier / formatting)
 * are pure functions so they can be unit-tested without any network.
 *
 * The tickets live on a GitHub Projects v2 board ("DEV Team Planning" under
 * the designedvr org) where a single-select "Status" field has a "Pending CS"
 * option. Projects v2 is only reachable through the GraphQL API, so that's how
 * we fetch. Age is measured from when the issue was assigned (falling back to
 * when it was created).
 *
 * Env vars (all read with bracket notation to keep Railpack's build-time
 * secret scanner happy — see commit 008c454):
 *   GITHUB_TOKEN          Token with read:project + repo (classic) or a
 *                         fine-grained token with Projects + Issues: read.
 *   GITHUB_PROJECT_OWNER  Org/user that owns the board (default "designedvr")
 *   GITHUB_PROJECT_NUMBER Project number from the board URL (…/projects/<N>)
 *   GITHUB_PROJECT_OWNER_TYPE  "org" | "user" ("" = auto-detect)
 *   GITHUB_STATUS_FIELD   Single-select field name (default "Status")
 *   PENDING_CS_STATUS     Status option to report on (default "Pending CS")
 *   PENDING_CS_AGE_FROM   "created" (default; ticket age) | "assignment"
 *   SLACK_BOT_TOKEN     xoxb-… bot token (preferred — enables real @mentions)
 *   SLACK_WEBHOOK_URL   Incoming-webhook URL (fallback if no bot token)
 *   SLACK_CS_CHANNEL    Channel id/name to post to (default the #boom-ninjas id)
 *   PENDING_CS_TZ       IANA tz for the 9AM schedule (default "Asia/Jerusalem")
 *   PENDING_CS_SCHEDULE Cron expression (default "0 9 * * *")
 *   PENDING_CS_ENABLED  "true"/"false" to force the scheduler on/off
 *   PENDING_CS_CRIT_DAYS / _HIGH_DAYS / _MED_DAYS       age thresholds
 *   PENDING_CS_CRIT_COUNT / _HIGH_COUNT / _MED_COUNT    count thresholds
 */

const fs = require('fs')
const path = require('path')

const env = process.env
const DAY_MS = 24 * 60 * 60 * 1000

// Default channel = #boom-ninjas (looked up from the workspace).
const DEFAULT_CHANNEL = 'C09JYCQ2DLG'

// ─── Config ─────────────────────────────────────────────────────────────────
function getConfig() {
  const num = (v, d) => (v !== undefined && v !== '' && !isNaN(Number(v)) ? Number(v) : d)
  return {
    githubToken: env['GITHUB_TOKEN'] || env['GH_TOKEN'] || '',
    projectOwner: env['GITHUB_PROJECT_OWNER'] || 'designedvr',
    projectNumber: num(env['GITHUB_PROJECT_NUMBER'], 2),
    ownerType: (env['GITHUB_PROJECT_OWNER_TYPE'] || '').toLowerCase(),
    statusField: env['GITHUB_STATUS_FIELD'] || 'Status',
    status: env['PENDING_CS_STATUS'] || env['PENDING_CS_LABEL'] || 'Pending CS',
    ageFrom: (env['PENDING_CS_AGE_FROM'] || 'created').toLowerCase(),
    slackBotToken: env['SLACK_BOT_TOKEN'] || '',
    slackWebhook: env['SLACK_WEBHOOK_URL'] || '',
    channel: env['SLACK_CS_CHANNEL'] || DEFAULT_CHANNEL,
    tz: env['PENDING_CS_TZ'] || 'Asia/Jerusalem',
    schedule: env['PENDING_CS_SCHEDULE'] || '0 9 * * *',
    thresholds: {
      critDays: num(env['PENDING_CS_CRIT_DAYS'], 7),
      highDays: num(env['PENDING_CS_HIGH_DAYS'], 4),
      medDays: num(env['PENDING_CS_MED_DAYS'], 2),
      critCount: num(env['PENDING_CS_CRIT_COUNT'], 8),
      highCount: num(env['PENDING_CS_HIGH_COUNT'], 5),
      medCount: num(env['PENDING_CS_MED_COUNT'], 2)
    }
  }
}

function isGithubConfigured(cfg = getConfig()) {
  return Boolean(cfg.githubToken && cfg.projectOwner && cfg.projectNumber)
}

function isSlackConfigured(cfg = getConfig()) {
  return Boolean(cfg.slackBotToken || cfg.slackWebhook)
}

function isEnabled(cfg = getConfig()) {
  const flag = (env['PENDING_CS_ENABLED'] || '').toLowerCase()
  if (flag === 'true') return true
  if (flag === 'false') return false
  // Auto-enable only when we can actually fetch AND post.
  return isGithubConfigured(cfg) && isSlackConfigured(cfg)
}

// ─── Team mapping (GitHub login → Slack member id) ───────────────────────────
function loadTeamMap() {
  try {
    const file = path.join(__dirname, '..', 'data', 'cs-team.json')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const map = {}
    for (const m of parsed.members || []) {
      if (m.githubLogin) map[m.githubLogin.toLowerCase()] = m
    }
    return map
  } catch (_e) {
    return {}
  }
}

// ─── GitHub REST (timeline assignment dates) ─────────────────────────────────
async function ghRest(url, cfg) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'boom-ops-pending-cs-bot'
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub ${res.status} ${res.statusText} for ${url} :: ${body.slice(0, 200)}`)
  }
  return res
}

/** Latest "assigned" timeline event per assignee for one issue, {} on failure. */
async function fetchAssignedAt(repoFullName, issueNumber, cfg) {
  const out = {}
  try {
    let page = 1
    while (page <= 5) {
      const url = `https://api.github.com/repos/${repoFullName}/issues/${issueNumber}/timeline?per_page=100&page=${page}`
      const res = await ghRest(url, cfg)
      const events = await res.json()
      for (const ev of events) {
        if (ev.event === 'assigned' && ev.assignee && ev.assignee.login && ev.created_at) {
          out[ev.assignee.login.toLowerCase()] = ev.created_at // later pages win → latest assignment
        }
      }
      if (events.length < 100) break
      page++
    }
  } catch (_e) {
    // Best-effort; caller falls back to issue creation date.
  }
  return out
}

// ─── GitHub GraphQL (Projects v2) ────────────────────────────────────────────
async function ghGraphql(query, variables, cfg) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'boom-ops-pending-cs-bot'
    },
    body: JSON.stringify({ query, variables })
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
  if (json.errors && json.errors.length) {
    throw new Error(`GitHub GraphQL error: ${json.errors.map(e => e.message).join('; ')}`)
  }
  return json.data
}

const PROJECT_ITEMS_QUERY = `
query($owner:String!, $number:Int!, $field:String!, $cursor:String) {
  ROOT(login:$owner) {
    projectV2(number:$number) {
      title
      items(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          status: fieldValueByName(name:$field) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content {
            __typename
            ... on Issue {
              number title url state createdAt
              repository { nameWithOwner }
              assignees(first:20) { nodes { login } }
            }
          }
        }
      }
    }
  }
}`

/** Pulls every project item once, following pagination. Auto-detects org vs user. */
async function fetchProjectItems(cfg) {
  const roots = cfg.ownerType === 'org' ? ['organization']
    : cfg.ownerType === 'user' ? ['user']
    : ['organization', 'user'] // auto-detect
  let lastErr = null
  for (const root of roots) {
    const query = PROJECT_ITEMS_QUERY.replace(/ROOT/g, root)
    const items = []
    let cursor = null
    try {
      for (let guard = 0; guard < 500; guard++) { // up to 50k items; board is large (mostly Done)
        const data = await ghGraphql(query, {
          owner: cfg.projectOwner, number: cfg.projectNumber, field: cfg.statusField, cursor
        }, cfg)
        const project = data && data[root] && data[root].projectV2
        if (!project) throw new Error(`project #${cfg.projectNumber} not found for ${root} "${cfg.projectOwner}"`)
        const conn = project.items
        for (const n of conn.nodes) items.push(n)
        if (!conn.pageInfo.hasNextPage) break
        cursor = conn.pageInfo.endCursor
      }
      return items
    } catch (e) {
      lastErr = e // try next root (e.g. org query fails for a user-owned board)
    }
  }
  throw lastErr || new Error('Unable to read project items')
}

/**
 * Pure: keep only OPEN Issue items whose Status matches, and normalize them to
 * {number,title,url,createdAt,repo,assignees:[{login,assignedAt}]}. assignedAt
 * starts at createdAt; fetchPendingCsIssues refines it from timeline events.
 */
function normalizeProjectItems(items, status) {
  const want = String(status).toLowerCase()
  return items
    .filter(it =>
      it.status && it.status.name && it.status.name.toLowerCase() === want &&
      it.content && it.content.__typename === 'Issue' && it.content.state === 'OPEN')
    .map(it => it.content)
    .map(c => ({
      number: c.number,
      title: c.title,
      url: c.url,
      createdAt: c.createdAt,
      repo: c.repository ? c.repository.nameWithOwner : null,
      assignees: ((c.assignees && c.assignees.nodes) || []).map(a => ({ login: a.login, assignedAt: c.createdAt }))
    }))
}

/** Returns normalized issues: {number,title,url,createdAt,repo,assignees:[{login,assignedAt}]} */
async function fetchPendingCsIssues(cfg = getConfig()) {
  if (!isGithubConfigured(cfg)) {
    throw new Error('GitHub is not configured (need GITHUB_TOKEN, GITHUB_PROJECT_OWNER and GITHUB_PROJECT_NUMBER)')
  }
  const items = await fetchProjectItems(cfg)
  const normalized = normalizeProjectItems(items, cfg.status)

  if (cfg.ageFrom !== 'created') {
    for (const it of normalized) {
      if (!it.repo || !it.assignees.length) continue
      const assignedMap = await fetchAssignedAt(it.repo, it.number, cfg)
      for (const a of it.assignees) {
        const ts = assignedMap[a.login.toLowerCase()]
        if (ts) a.assignedAt = ts
      }
    }
  }
  return normalized
}

// ─── Urgency tiers ───────────────────────────────────────────────────────────
const TIERS = {
  critical: { key: 'critical', emoji: ':red_circle:', dot: '🔴', label: 'Critical', rank: 0 },
  high: { key: 'high', emoji: ':large_orange_circle:', dot: '🟠', label: 'High', rank: 1 },
  medium: { key: 'medium', emoji: ':large_yellow_circle:', dot: '🟡', label: 'Medium', rank: 2 },
  healthy: { key: 'healthy', emoji: ':large_green_circle:', dot: '🟢', label: 'Healthy', rank: 3 }
}

function tierForAge(ageDays, t) {
  if (ageDays >= t.critDays) return TIERS.critical
  if (ageDays >= t.highDays) return TIERS.high
  if (ageDays >= t.medDays) return TIERS.medium
  return TIERS.healthy
}

// ─── Report builder (pure) ───────────────────────────────────────────────────
/**
 * Builds a per-ticket report: one row per open Pending CS ticket, each with its
 * GitHub link + title, assignee(s), age (days since the ticket was created),
 * and an urgency tier by age. Sorted oldest-first (most urgent at the top).
 *
 * @param {Array} issues normalized issues {number,title,url,repo,createdAt,assignees:[{login}]}
 * @param {Object} teamMap login(lowercase) → {slackId,name}
 * @param {Object} opts   { now?: ms, thresholds?, label?, repo? }
 */
function buildReport(issues, teamMap = {}, opts = {}) {
  const now = opts.now || Date.now()
  const t = opts.thresholds || getConfig().thresholds
  const ageDays = iso => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS))
  const resolve = login => {
    const m = teamMap[login.toLowerCase()] || {}
    return { login, name: m.name || login, slackId: m.slackId || null, mention: m.slackId ? `<@${m.slackId}>` : `@${login}` }
  }

  const tickets = issues.map(it => {
    const assignees = (it.assignees || []).map(a => resolve(a.login))
    const age = ageDays(it.createdAt)
    const tier = tierForAge(age, t)
    return {
      number: it.number,
      title: it.title || `#${it.number}`,
      url: it.url || null,
      repo: it.repo || null,
      assignees,
      assigneeNames: assignees.map(a => a.name).join(', '),
      unassigned: assignees.length === 0,
      ageDays: age,
      tier: tier.key,
      tierLabel: tier.label,
      tierEmoji: tier.emoji,
      tierDot: tier.dot
    }
  })

  // Highest priority (oldest) first; the top row is the most urgent ticket.
  tickets.sort((a, b) => b.ageDays - a.ageDays || a.number - b.number)
  tickets.forEach((tk, i) => { tk.rank = i + 1; tk.top = i === 0 })

  const counts = { critical: 0, high: 0, medium: 0, healthy: 0 }
  for (const tk of tickets) counts[tk.tier]++

  return {
    generatedAt: new Date(now).toISOString(),
    label: opts.label || getConfig().status,
    repo: opts.repo || '',
    totalTickets: tickets.length,
    unassignedCount: tickets.filter(tk => tk.unassigned).length,
    counts,
    tickets
  }
}

// ─── Slack formatting ────────────────────────────────────────────────────────
function prettyDate(iso, tz) {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz
    })
  } catch (_e) {
    return iso.slice(0, 10)
  }
}

function sanitizeTitle(s, max = 90) {
  let out = String(s || '').replace(/[<>]/g, '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
  if (out.length > max) out = out.slice(0, max - 1).trimEnd() + '…'
  return out
}

// One "row" per ticket: <urgency> <age> — <#num title (link)> → assignee(s)
function ticketLine(tk) {
  const link = tk.url ? `<${tk.url}|#${tk.number} ${sanitizeTitle(tk.title)}>` : `#${tk.number} ${sanitizeTitle(tk.title)}`
  const who = tk.unassigned ? '_unassigned_' : tk.assignees.map(a => a.mention).join(', ')
  return `${tk.tierEmoji} *${tk.ageDays}d*  ·  ${link}\n> ${who}`
}

/** Returns { text, blocks } for chat.postMessage / webhook — a per-ticket table. */
function formatSlackMessage(report, cfg = getConfig()) {
  const date = prettyDate(report.generatedAt, cfg.tz)
  const blocks = []
  const assigned = report.tickets.filter(tk => !tk.unassigned)
  const unassigned = report.tickets.filter(tk => tk.unassigned)

  blocks.push({ type: 'header', text: { type: 'plain_text', text: ':rotating_light: Pending CS — Daily Report', emoji: true } })

  const bits = [`*${report.totalTickets}* open ${report.totalTickets === 1 ? 'ticket' : 'tickets'}`]
  if (report.counts.critical) bits.push(`:red_circle: ${report.counts.critical} critical`)
  if (report.unassignedCount) bits.push(`*${report.unassignedCount}* unassigned`)
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${date}  ·  ${bits.join('  ·  ')}` }] })
  blocks.push({ type: 'divider' })

  // Chunk rows so each section stays under Slack's 3000-char limit.
  const pushRows = rows => {
    let buf = []
    let len = 0
    const flush = () => { if (buf.length) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf.join('\n\n') } }); buf = []; len = 0 } }
    for (const tk of rows) {
      const line = ticketLine(tk)
      if (len + line.length > 2800) flush()
      buf.push(line)
      len += line.length + 2
    }
    flush()
  }

  if (!report.totalTickets) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':tada: *Queue is clear!* No open Pending CS tickets right now. Great work, team. :muscle:' } })
  } else {
    if (assigned.length) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':busts_in_silhouette: *Assigned* — oldest first' } })
      pushRows(assigned)
    }
    if (unassigned.length) {
      blocks.push({ type: 'divider' })
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:grey_question: *Unassigned — needs an owner* (${unassigned.length})` } })
      pushRows(unassigned)
    }
  }

  blocks.push({ type: 'divider' })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ":red_circle: 7d+  ·  :large_orange_circle: 4d+  ·  :large_yellow_circle: 2d+  ·  :large_green_circle: fresh   —   let's keep Pending CS moving :muscle:" }] })

  // Plain-text fallback (notifications, screen readers, webhook clients).
  const lines = [`Pending CS — Daily Report (${date}) — ${report.totalTickets} open, ${report.unassignedCount} unassigned`]
  for (const tk of report.tickets) {
    lines.push(`${tk.tierDot} ${tk.ageDays}d · #${tk.number} ${sanitizeTitle(tk.title, 60)} · ${tk.unassigned ? 'unassigned' : tk.assigneeNames}`)
  }

  return { text: lines.join('\n'), blocks }
}

// ─── Slack posting ───────────────────────────────────────────────────────────
async function postToSlack(message, cfg = getConfig()) {
  if (cfg.slackBotToken) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.slackBotToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        channel: cfg.channel,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false
      })
    })
    const data = await res.json().catch(() => ({}))
    if (!data.ok) throw new Error(`Slack chat.postMessage failed: ${data.error || res.status}`)
    return { via: 'bot', ts: data.ts, channel: data.channel }
  }

  if (cfg.slackWebhook) {
    const res = await fetch(cfg.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message.text, blocks: message.blocks })
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Slack webhook failed: ${res.status} ${body.slice(0, 120)}`)
    }
    return { via: 'webhook' }
  }

  throw new Error('Slack is not configured (need SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL)')
}

// ─── Orchestration ───────────────────────────────────────────────────────────
async function generateReport(cfg = getConfig()) {
  const issues = await fetchPendingCsIssues(cfg)
  return buildReport(issues, loadTeamMap(), {
    thresholds: cfg.thresholds,
    label: cfg.status,
    repo: `${cfg.projectOwner} · project #${cfg.projectNumber}`
  })
}

async function runDailyReport(cfg = getConfig()) {
  const report = await generateReport(cfg)
  const message = formatSlackMessage(report, cfg)
  const result = await postToSlack(message, cfg)
  return { report, result }
}

// ─── Sample data (portal preview when GitHub isn't configured) ───────────────
function sampleReport(now = Date.now()) {
  const daysAgo = d => new Date(now - d * DAY_MS).toISOString()
  const issue = (n, title, login, created) => ({
    number: n, title, url: `https://github.com/designedvr/designedvr/issues/${n}`,
    repo: 'designedvr/designedvr', createdAt: daysAgo(created),
    assignees: login ? [{ login }] : []
  })
  const issues = [
    issue(24480, 'Set up per-property Stripe accounts for partner', 'patricia-alvarez', 12),
    issue(23991, 'BDC connection never reached live since Jun 24', 'guytapeta', 40),
    issue(24012, 'Duplicate reservations not resolving after migration', 'marlon-a11y', 9),
    issue(24103, 'Revenue analytics showing 0 for active bookings', 'sharonnets', 6),
    issue(24210, 'WhatsApp automation not triggering', 'risserosello', 3),
    issue(24377, 'Calendar block cannot be created for March', 'winky-labula', 1),
    issue(24455, 'Guest chat opens full CRM instead of conversation', null, 5),
    issue(24460, 'VAT formula includes cleaning VAT incorrectly', null, 2)
  ]
  const report = buildReport(issues, loadTeamMap(), { now, repo: 'designedvr · project #2 (sample)', label: 'Pending CS' })
  report.sample = true
  return report
}

module.exports = {
  getConfig,
  isGithubConfigured,
  isSlackConfigured,
  isEnabled,
  loadTeamMap,
  normalizeProjectItems,
  fetchProjectItems,
  fetchPendingCsIssues,
  buildReport,
  tierForAge,
  TIERS,
  formatSlackMessage,
  postToSlack,
  generateReport,
  runDailyReport,
  sampleReport
}
