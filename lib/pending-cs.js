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
 *   PENDING_CS_AGE_FROM   "assignment" | "created" (default "assignment")
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
    ageFrom: (env['PENDING_CS_AGE_FROM'] || 'assignment').toLowerCase(),
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
      for (let guard = 0; guard < 50; guard++) {
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

function tierFor(count, oldestDays, t) {
  if (oldestDays >= t.critDays || count >= t.critCount) return TIERS.critical
  if (oldestDays >= t.highDays || count >= t.highCount) return TIERS.high
  if (oldestDays >= t.medDays || count >= t.medCount) return TIERS.medium
  return TIERS.healthy
}

// ─── Report builder (pure) ───────────────────────────────────────────────────
/**
 * @param {Array} issues normalized issues
 * @param {Object} teamMap login(lowercase) → {slackId,name}
 * @param {Object} opts   { now?: ms, thresholds? }
 */
function buildReport(issues, teamMap = {}, opts = {}) {
  const now = opts.now || Date.now()
  const t = opts.thresholds || getConfig().thresholds
  const ageDays = iso => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS))

  const byLogin = new Map()
  const unassignedAges = []

  for (const issue of issues) {
    if (!issue.assignees || !issue.assignees.length) {
      unassignedAges.push(ageDays(issue.createdAt))
      continue
    }
    for (const a of issue.assignees) {
      const key = a.login.toLowerCase()
      if (!byLogin.has(key)) byLogin.set(key, { login: a.login, ages: [] })
      byLogin.get(key).ages.push(ageDays(a.assignedAt || issue.createdAt))
    }
  }

  const rows = [...byLogin.values()].map(r => {
    const count = r.ages.length
    const oldest = r.ages.reduce((m, v) => Math.max(m, v), 0)
    const avg = Math.round(r.ages.reduce((s, v) => s + v, 0) / count)
    const member = teamMap[r.login.toLowerCase()] || {}
    const tier = tierFor(count, oldest, t)
    return {
      login: r.login,
      name: member.name || r.login,
      slackId: member.slackId || null,
      mention: member.slackId ? `<@${member.slackId}>` : `@${r.login}`,
      count,
      oldestDays: oldest,
      avgDays: avg,
      tier: tier.key,
      tierLabel: tier.label,
      tierEmoji: tier.emoji,
      tierDot: tier.dot,
      // Priority: most tickets first, then oldest backlog, then higher average.
      score: count * 1000 + oldest * 10 + avg
    }
  })

  rows.sort((a, b) =>
    b.count - a.count ||
    b.oldestDays - a.oldestDays ||
    b.avgDays - a.avgDays ||
    a.login.localeCompare(b.login)
  )
  rows.forEach((r, i) => { r.rank = i + 1; r.top = i === 0 })

  const unassigned = unassignedAges.length
    ? {
        count: unassignedAges.length,
        oldestDays: unassignedAges.reduce((m, v) => Math.max(m, v), 0),
        avgDays: Math.round(unassignedAges.reduce((s, v) => s + v, 0) / unassignedAges.length)
      }
    : { count: 0, oldestDays: 0, avgDays: 0 }

  return {
    generatedAt: new Date(now).toISOString(),
    label: (opts.label || getConfig().status),
    repo: opts.repo || '',
    totalTickets: issues.length,
    assignedTickets: issues.filter(i => i.assignees && i.assignees.length).length,
    totalAssignees: rows.length,
    counts: {
      critical: rows.filter(r => r.tier === 'critical').length,
      high: rows.filter(r => r.tier === 'high').length,
      medium: rows.filter(r => r.tier === 'medium').length,
      healthy: rows.filter(r => r.tier === 'healthy').length
    },
    unassigned,
    rows
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

function rowLine(r) {
  const crown = r.top ? ' :crown:' : ''
  const plural = r.count === 1 ? 'ticket' : 'tickets'
  return `${r.tierEmoji} ${r.mention}${crown}\n` +
    `> *${r.count}* ${plural} · oldest *${r.oldestDays}d* · avg *${r.avgDays}d* · _${r.tierLabel}_`
}

/** Returns { text, blocks } for chat.postMessage / webhook. */
function formatSlackMessage(report, cfg = getConfig()) {
  const date = prettyDate(report.generatedAt, cfg.tz)
  const blocks = []

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: ':rotating_light: Pending CS — Daily Report', emoji: true }
  })

  const summaryBits = [
    `*${report.totalTickets}* open Pending CS ${report.totalTickets === 1 ? 'ticket' : 'tickets'}`,
    `*${report.totalAssignees}* ${report.totalAssignees === 1 ? 'ninja' : 'ninjas'} with a queue`
  ]
  if (report.unassigned.count) summaryBits.push(`*${report.unassigned.count}* unassigned`)
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `${date}  ·  ${summaryBits.join('  ·  ')}` }]
  })
  blocks.push({ type: 'divider' })

  if (!report.rows.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':tada: *Queue is clear!* No open Pending CS tickets are assigned right now. Great work, team. :muscle:' }
    })
  } else {
    // Chunk rows so we stay under Slack's 3000-char section limit.
    let buf = []
    let len = 0
    const flush = () => {
      if (!buf.length) return
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: buf.join('\n\n') } })
      buf = []
      len = 0
    }
    for (const r of report.rows) {
      const line = rowLine(r)
      if (len + line.length > 2800) flush()
      buf.push(line)
      len += line.length + 2
    }
    flush()
  }

  if (report.unassigned.count) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:grey_question: *Unassigned* — *${report.unassigned.count}* ${report.unassigned.count === 1 ? 'ticket needs' : 'tickets need'} an owner ` +
          `(oldest *${report.unassigned.oldestDays}d*). Let's grab these first.`
      }
    })
  }

  blocks.push({ type: 'divider' })
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: ':red_circle: Critical  ·  :large_orange_circle: High  ·  :large_yellow_circle: Medium  ·  :large_green_circle: Healthy   —   Keep your Pending CS queue under control :muscle:'
    }]
  })

  // Plain-text fallback (notifications, screen readers, webhook clients).
  const textLines = [`:rotating_light: Pending CS — Daily Report (${date})`]
  for (const r of report.rows) {
    textLines.push(`${r.tierDot} ${r.name}${r.top ? ' 👑' : ''}: ${r.count} open, oldest ${r.oldestDays}d, avg ${r.avgDays}d (${r.tierLabel})`)
  }
  if (report.unassigned.count) textLines.push(`❔ Unassigned: ${report.unassigned.count} (oldest ${report.unassigned.oldestDays}d)`)
  const text = textLines.join('\n')

  return { text, blocks }
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
  const issue = (n, login, created, assigned) => ({
    number: n, title: `Sample ticket #${n}`, url: '#', createdAt: daysAgo(created),
    assignees: login ? [{ login, assignedAt: daysAgo(assigned == null ? created : assigned) }] : []
  })
  const issues = [
    issue(101, 'cindy', 11, 11), issue(102, 'cindy', 6, 6), issue(103, 'cindy', 4, 4),
    issue(104, 'cindy', 3, 3), issue(105, 'cindy', 2, 2), issue(106, 'cindy', 1, 1),
    issue(107, 'din', 5, 5), issue(108, 'din', 3, 3), issue(109, 'din', 2, 2), issue(110, 'din', 1, 1),
    issue(111, 'patricia', 4, 4), issue(112, 'patricia', 2, 2), issue(113, 'patricia', 1, 1),
    issue(114, 'risse', 2, 2), issue(115, 'risse', 1, 1),
    issue(116, 'winky', 1, 1),
    issue(117, null, 8, null)
  ]
  const report = buildReport(issues, loadTeamMap(), { now, repo: 'boomnow/support (sample)', label: 'Pending CS' })
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
  tierFor,
  TIERS,
  formatSlackMessage,
  postToSlack,
  generateReport,
  runDailyReport,
  sampleReport
}
