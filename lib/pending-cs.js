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
 * Env vars (all read with bracket notation to keep Railpack's build-time
 * secret scanner happy — see commit 008c454):
 *   GITHUB_TOKEN        Personal access / fine-grained token (repo:read)
 *   GITHUB_REPO         "owner/repo" that holds the CS tickets
 *   PENDING_CS_LABEL    Label that marks the status (default "Pending CS")
 *   PENDING_CS_AGE_FROM "assignment" | "created" (default "assignment")
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
    repo: env['GITHUB_REPO'] || '',
    label: env['PENDING_CS_LABEL'] || 'Pending CS',
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
  return Boolean(cfg.githubToken && cfg.repo)
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

// ─── GitHub fetch ────────────────────────────────────────────────────────────
async function ghRequest(url, cfg) {
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

/** Latest "assigned" timeline event per current assignee, else null. */
async function fetchAssignedAt(issueNumber, cfg) {
  const out = {}
  try {
    let page = 1
    while (page <= 5) {
      const url = `https://api.github.com/repos/${cfg.repo}/issues/${issueNumber}/timeline?per_page=100&page=${page}`
      const res = await ghRequest(url, cfg)
      const events = await res.json()
      for (const ev of events) {
        if (ev.event === 'assigned' && ev.assignee && ev.assignee.login && ev.created_at) {
          out[ev.assignee.login.toLowerCase()] = ev.created_at // later pages overwrite → latest wins
        }
      }
      if (events.length < 100) break
      page++
    }
  } catch (_e) {
    // Timeline is best-effort; caller falls back to created_at.
  }
  return out
}

/** Returns normalized issues: {number,title,url,createdAt,assignees:[{login,assignedAt}]} */
async function fetchPendingCsIssues(cfg = getConfig()) {
  if (!isGithubConfigured(cfg)) throw new Error('GitHub is not configured (need GITHUB_TOKEN and GITHUB_REPO)')
  const issues = []
  let page = 1
  while (page <= 20) {
    const url = `https://api.github.com/repos/${cfg.repo}/issues?state=open&labels=${encodeURIComponent(cfg.label)}&per_page=100&page=${page}`
    const res = await ghRequest(url, cfg)
    const batch = await res.json()
    for (const it of batch) {
      if (it.pull_request) continue // /issues also returns PRs — skip them
      issues.push(it)
    }
    if (batch.length < 100) break
    page++
  }

  const useAssignment = cfg.ageFrom !== 'created'
  const normalized = []
  for (const it of issues) {
    const assignees = (it.assignees && it.assignees.length ? it.assignees : it.assignee ? [it.assignee] : [])
      .map(a => ({ login: a.login, assignedAt: it.created_at }))
    if (useAssignment && assignees.length) {
      const assignedMap = await fetchAssignedAt(it.number, cfg)
      for (const a of assignees) {
        const ts = assignedMap[a.login.toLowerCase()]
        if (ts) a.assignedAt = ts
      }
    }
    normalized.push({
      number: it.number,
      title: it.title,
      url: it.html_url,
      createdAt: it.created_at,
      assignees
    })
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
    label: (opts.label || getConfig().label),
    repo: opts.repo || getConfig().repo || '',
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
    label: cfg.label,
    repo: cfg.repo
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
