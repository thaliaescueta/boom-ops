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
    minAgeHours: num(env['PENDING_CS_MIN_AGE_HOURS'], 24),
    slackBotToken: env['SLACK_BOT_TOKEN'] || '',
    slackWebhook: env['SLACK_WEBHOOK_URL'] || '',
    channel: env['SLACK_CS_CHANNEL'] || DEFAULT_CHANNEL,
    // 'canvas' updates the channel's canvas in place; 'message' posts a chat message.
    // Defaults to canvas when a bot token is available (canvases need one), else message.
    output: (env['PENDING_CS_OUTPUT'] || (env['SLACK_BOT_TOKEN'] ? 'canvas' : 'message')).toLowerCase(),
    // Fixed canvas id to edit daily — set after first creation so the job needs
    // only canvases:write (no channels:read lookup).
    canvasId: env['PENDING_CS_CANVAS_ID'] || '',
    canvasUrl: env['PENDING_CS_CANVAS_URL'] || 'https://boomnoworkspace.slack.com/docs/T05SAPSM38A/F0BHMFKN51B',
    // In canvas mode, also drop a preview card in the channel feed (via webhook).
    postCard: (env['PENDING_CS_POST_CARD'] || 'true').toLowerCase() !== 'false',
    // Who to notify on the card: 'channel' (@channel), 'here' (@here), or 'none'.
    notify: (env['PENDING_CS_NOTIFY'] || 'channel').toLowerCase(),
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

// Urgency by how many aging (>24h) tickets an agent is carrying — the metric the
// table ranks on. (oldestDays kept in the signature for callers/tuning.)
function tierForAgent(count, _oldestDays, _t) {
  if (count >= 4) return TIERS.critical
  if (count >= 2) return TIERS.high
  if (count >= 1) return TIERS.medium
  return TIERS.healthy
}

// ─── Report builder (pure) ───────────────────────────────────────────────────
/**
 * Builds a per-agent table: one row per assignee, counting only tickets that
 * have been open longer than `minAgeHours` (default 24h). Each row carries the
 * count, the oldest age, an urgency tier, and links to that agent's aging
 * tickets. Rows are sorted by count (then oldest) — most action needed first.
 * Aging tickets with no assignee are collected under `unassigned`.
 *
 * @param {Array} issues normalized issues {number,title,url,repo,createdAt,assignees:[{login}]}
 * @param {Object} teamMap login(lowercase) → {slackId,name}
 * @param {Object} opts   { now?: ms, thresholds?, minAgeHours?, label?, repo? }
 */
function buildReport(issues, teamMap = {}, opts = {}) {
  const now = opts.now || Date.now()
  const t = opts.thresholds || getConfig().thresholds
  const minHours = opts.minAgeHours != null ? opts.minAgeHours : getConfig().minAgeHours
  const ageDays = iso => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS))
  const ageHours = iso => (now - new Date(iso).getTime()) / (60 * 60 * 1000)
  const resolve = login => {
    const m = teamMap[login.toLowerCase()] || {}
    return { login, name: m.name || login, slackId: m.slackId || null, mention: m.slackId ? `<@${m.slackId}>` : `@${login}` }
  }

  const byLogin = new Map()
  const unassignedTix = []
  let agingTotal = 0

  for (const it of issues) {
    if (ageHours(it.createdAt) <= minHours) continue // only tickets open longer than the threshold
    agingTotal++
    const tk = { number: it.number, title: it.title || `#${it.number}`, url: it.url || null, repo: it.repo || null, ageDays: ageDays(it.createdAt) }
    const assignees = it.assignees || []
    if (!assignees.length) { unassignedTix.push(tk); continue }
    for (const a of assignees) {
      const key = a.login.toLowerCase()
      if (!byLogin.has(key)) byLogin.set(key, { ...resolve(a.login), tickets: [] })
      byLogin.get(key).tickets.push(tk)
    }
  }

  const agents = [...byLogin.values()].map(g => {
    const tickets = g.tickets.slice().sort((a, b) => b.ageDays - a.ageDays || a.number - b.number)
    const count = tickets.length
    const oldestDays = tickets.reduce((m, x) => Math.max(m, x.ageDays), 0)
    const tier = tierForAgent(count, oldestDays, t)
    return {
      login: g.login, name: g.name, slackId: g.slackId, mention: g.mention,
      count, oldestDays, tickets,
      tier: tier.key, tierLabel: tier.label, tierEmoji: tier.emoji, tierDot: tier.dot
    }
  })

  // Most aging tickets first; ties broken by the oldest ticket, then name.
  agents.sort((a, b) => b.count - a.count || b.oldestDays - a.oldestDays || a.name.localeCompare(b.name))
  agents.forEach((a, i) => { a.rank = i + 1; a.top = i === 0 })

  const counts = { critical: 0, high: 0, medium: 0, healthy: 0 }
  for (const a of agents) counts[a.tier]++

  const unassigned = {
    count: unassignedTix.length,
    oldestDays: unassignedTix.reduce((m, x) => Math.max(m, x.ageDays), 0),
    tickets: unassignedTix.slice().sort((a, b) => b.ageDays - a.ageDays || a.number - b.number)
  }

  return {
    generatedAt: new Date(now).toISOString(),
    label: opts.label || getConfig().status,
    repo: opts.repo || '',
    minAgeHours: minHours,
    totalTickets: issues.length,
    agingTickets: agingTotal,
    totalAgents: agents.length,
    counts,
    agents,
    unassigned
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

// A short link per ticket, e.g. <url|#21170 (49d)>
function ticketChip(tk) {
  return tk.url ? `<${tk.url}|#${tk.number}·${tk.ageDays}d>` : `#${tk.number}·${tk.ageDays}d`
}

// One "row" per agent: <urgency> <name> — <N> open >24h : link · link · …
function agentLine(a) {
  const crown = a.top ? ' :crown:' : ''
  const links = a.tickets.map(ticketChip).join('  ·  ')
  return `${a.tierEmoji} ${a.mention}${crown} — *${a.count}* open >24h\n> ${links}`
}

/** Returns { text, blocks } for chat.postMessage / webhook — a per-agent table. */
function formatSlackMessage(report, cfg = getConfig()) {
  const date = prettyDate(report.generatedAt, cfg.tz)
  const blocks = []

  blocks.push({ type: 'header', text: { type: 'plain_text', text: ':rotating_light: Pending CS — Aging Tickets (>24h)', emoji: true } })

  const bits = [`*${report.agingTickets}* ${report.agingTickets === 1 ? 'ticket' : 'tickets'} open >24h`, `*${report.totalAgents}* ${report.totalAgents === 1 ? 'agent' : 'agents'}`]
  if (report.unassigned.count) bits.push(`*${report.unassigned.count}* unassigned`)
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${date}  ·  ${bits.join('  ·  ')}` }] })
  blocks.push({ type: 'divider' })

  // Chunk rows so each section stays under Slack's 3000-char limit.
  const pushRows = rows => {
    let buf = []
    let len = 0
    const flush = () => { if (buf.length) { blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf.join('\n\n') } }); buf = []; len = 0 } }
    for (const line of rows) {
      if (len + line.length > 2800) flush()
      buf.push(line)
      len += line.length + 2
    }
    flush()
  }

  if (!report.agingTickets) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':tada: *Nothing aging!* No Pending CS tickets have been open longer than 24h. Great work, team. :muscle:' } })
  } else {
    if (report.agents.length) pushRows(report.agents.map(agentLine))
    if (report.unassigned.count) {
      blocks.push({ type: 'divider' })
      const links = report.unassigned.tickets.map(ticketChip).join('  ·  ')
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:grey_question: *Unassigned* — *${report.unassigned.count}* open >24h\n> ${links}` } })
    }
  }

  blocks.push({ type: 'divider' })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ":red_circle: 4+ open >24h  ·  :large_orange_circle: 2–3  ·  :large_yellow_circle: 1   —   let's clear the aging queue :muscle:" }] })

  // Plain-text fallback (notifications, screen readers, webhook clients).
  const lines = [`Pending CS — Aging Tickets >24h (${date}) — ${report.agingTickets} tickets, ${report.totalAgents} agents, ${report.unassigned.count} unassigned`]
  for (const a of report.agents) {
    lines.push(`${a.tierDot} ${a.name}: ${a.count} open >24h (${a.tickets.map(tk => '#' + tk.number).join(', ')})`)
  }
  if (report.unassigned.count) lines.push(`❔ Unassigned: ${report.unassigned.count} (${report.unassigned.tickets.map(tk => '#' + tk.number).join(', ')})`)

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

// ─── Slack Canvas output (channel canvas, updated in place) ──────────────────
/** Canvas-flavored markdown: a real grid table with clickable ticket links. */
function buildCanvasMarkdown(report, cfg = getConfig()) {
  const date = prettyDate(report.generatedAt, cfg.tz)
  const head = [
    ':red_circle: **Pending CS — Aging Tickets (>24h)**',
    '',
    `_Updated ${date} · ${report.agingTickets} open >24h · ${report.totalAgents} agents · ${report.unassigned.count} unassigned_`,
    ''
  ]
  if (!report.agingTickets) {
    return head.concat([':tada: **Nothing aging** — no Pending CS tickets open longer than 24h.']).join('\n')
  }
  const rows = ['| Urgency | Agent | Open >24h | Oldest | Tickets |', '|---|---|---|---|---|']
  for (const a of report.agents) {
    const links = a.tickets.map(tk => tk.url ? `[#${tk.number}·${tk.ageDays}d](${tk.url})` : `#${tk.number}·${tk.ageDays}d`).join(' · ')
    rows.push(`| ${a.tierEmoji} | ${a.name}${a.top ? ' :crown:' : ''} | **${a.count}** | ${a.oldestDays}d | ${links} |`)
  }
  if (report.unassigned.count) {
    const links = report.unassigned.tickets.map(tk => tk.url ? `[#${tk.number}·${tk.ageDays}d](${tk.url})` : `#${tk.number}`).join(' · ')
    rows.push(`| :grey_question: | **Unassigned** | **${report.unassigned.count}** | ${report.unassigned.oldestDays}d | ${links} |`)
  }
  return head.concat(rows, ['', '_:red_circle: 4+ open >24h · :large_orange_circle: 2–3 · :large_yellow_circle: 1 — sorted by count, most aging first._']).join('\n')
}

async function slackApi(method, body, cfg) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.slackBotToken}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body)
  })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || res.status}`)
  return data
}

/** Create the channel's canvas if needed, else replace its content in place. */
async function postCanvas(report, cfg = getConfig()) {
  if (!cfg.slackBotToken) throw new Error('Canvas output needs SLACK_BOT_TOKEN (scope canvases:write).')
  const markdown = buildCanvasMarkdown(report, cfg)
  const replace = id => slackApi('canvases.edit', {
    canvas_id: id, changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown } }]
  }, cfg)

  // Fast path: a fixed canvas id is configured — edit it directly (canvases:write only).
  if (cfg.canvasId) {
    await replace(cfg.canvasId)
    return { via: 'canvas', canvasId: cfg.canvasId, created: false }
  }

  // Otherwise try to find the channel's existing canvas (needs channels:read); if
  // that scope is missing, fall through and create the channel canvas.
  let existingId = null
  try {
    const info = await slackApi('conversations.info', { channel: cfg.channel }, cfg)
    existingId = info.channel && info.channel.properties && info.channel.properties.canvas && info.channel.properties.canvas.file_id
  } catch (_e) { /* channels:read absent — create instead */ }

  if (existingId) {
    await replace(existingId)
    return { via: 'canvas', canvasId: existingId, created: false }
  }
  const created = await slackApi('conversations.canvases.create', {
    channel_id: cfg.channel,
    document_content: { type: 'markdown', markdown }
  }, cfg)
  return { via: 'canvas', canvasId: created.canvas_id, created: true }
}

// A channel-feed card that previews the canvas: summary + top agents + a button.
function buildPreviewCard(report, cfg = getConfig()) {
  const ping = cfg.notify === 'channel' ? '<!channel> ' : cfg.notify === 'here' ? '<!here> ' : ''
  const canvas = cfg.canvasUrl
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: ':rotating_light: Pending CS — Aging Tickets (>24h)', emoji: true } }
  ]
  if (ping) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${ping}please review your aging Pending CS tickets :point_down:` } })
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${report.agingTickets}* open >24h · *${report.totalAgents}* agents · *${report.unassigned.count}* unassigned` }] })

  if (report.agents.length) {
    const top = report.agents.slice(0, 6)
      .map(a => `${a.tierEmoji} *${a.name}*${a.top ? ' :crown:' : ''} — *${a.count}* open >24h · oldest *${a.oldestDays}d*`).join('\n')
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '*Top of the queue*\n' + top } })
  }
  if (canvas) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Full per-agent table with every ticket link is in the canvas :point_down:' }] })
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '📋 Open the Pending CS canvas', emoji: true }, url: canvas, style: 'primary' }] })
  }
  const text = `${ping}Pending CS — ${report.agingTickets} tickets open >24h across ${report.totalAgents} agents.` + (canvas ? ` Open the canvas: ${canvas}` : '')
  return { text, blocks }
}

async function postPreviewCard(report, cfg = getConfig()) {
  if (!cfg.slackWebhook) return null
  const res = await fetch(cfg.slackWebhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildPreviewCard(report, cfg))
  })
  if (!res.ok) throw new Error(`Slack webhook (card) failed: ${res.status}`)
  return { via: 'webhook-card' }
}

async function runDailyReport(cfg = getConfig()) {
  const report = await generateReport(cfg)
  if (cfg.output === 'canvas') {
    const result = await postCanvas(report, cfg)
    let card = null
    if (cfg.postCard) card = await postPreviewCard(report, cfg) // notify the channel with a preview card
    return { report, result, card }
  }
  const result = await postToSlack(formatSlackMessage(report, cfg), cfg)
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
    issue(24377, 'Calendar block cannot be created for March', 'patricia-alvarez', 5),
    issue(24210, 'WhatsApp automation not triggering', 'patricia-alvarez', 3),
    issue(23991, 'BDC connection never reached live since Jun 24', 'guytapeta', 40),
    issue(24012, 'Duplicate reservations not resolving after migration', 'guytapeta', 9),
    issue(24103, 'Revenue analytics showing 0 for active bookings', 'sharonnets', 6),
    issue(24240, 'Owner statement export missing cleaning fees', 'sharonnets', 2),
    issue(24290, 'Expedia rate uplift inconsistent across listings', 'risserosello', 3),
    issue(24455, 'Guest chat opens full CRM instead of conversation', null, 5),
    issue(24460, 'VAT formula includes cleaning VAT incorrectly', null, 2),
    issue(24999, 'Fresh ticket created moments ago (excluded, <24h)', 'winky-labula', 0)
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
  tierForAgent,
  TIERS,
  formatSlackMessage,
  postToSlack,
  buildCanvasMarkdown,
  postCanvas,
  buildPreviewCard,
  postPreviewCard,
  generateReport,
  runDailyReport,
  sampleReport
}
