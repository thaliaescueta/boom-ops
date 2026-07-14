const express = require('express')
const session = require('express-session')
const cron = require('node-cron')
const fs = require('fs')
const path = require('path')
const pendingCs = require('./lib/pending-cs')

const app = express()
const PORT = process.env.PORT || 3002

// ─── Credentials ─────────────────────────────────────────────────────────────
// Set VIEWER_USER, VIEWER_PASS, ADMIN_USER, ADMIN_PASS in Railway env vars.
// The values below are defaults for local development only.
const _env = process.env
const USERS = {
  [_env['VIEWER_USER'] || 'viewer']: {
    password: _env['VIEWER_PASS'] || 'viewer123',
    role: 'viewer'
  },
  [_env['ADMIN_USER'] || 'admin']: {
    password: _env['ADMIN_PASS'] || 'admin123',
    role: 'admin'
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(session({
  secret: _env['SESSION_SECRET'] || 'boom-report-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}))

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login')
  next()
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' })
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

// ─── Data ─────────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data', 'clients.json')

function readClients() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
}

function writeClients(clients) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(clients, null, 2))
}

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'))
})

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/')
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
})

app.post('/login', (req, res) => {
  const { username, password } = req.body
  const user = USERS[username]
  if (!user || user.password !== password) {
    return res.redirect('/login?error=1')
  }
  req.session.user = { username, role: user.role }
  res.redirect('/')
})

app.get('/logout', (req, res) => {
  req.session.destroy()
  res.redirect('/login')
})

app.get('/migration', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'migration.html'))
})

app.get('/weekly-report', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'weekly-report.html'))
})

app.get('/pending-cs', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pending-cs.html'))
})

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' })
  res.json(req.session.user)
})

app.get('/api/clients', requireAuth, (_req, res) => {
  res.json(readClients())
})

app.put('/api/clients/:id', requireAdmin, (req, res) => {
  const clients = readClients()
  const idx = clients.findIndex(c => c.id === parseInt(req.params.id))
  if (idx === -1) return res.status(404).json({ error: 'Not found' })
  clients[idx] = { ...clients[idx], ...req.body, id: clients[idx].id }
  writeClients(clients)
  res.json(clients[idx])
})

app.post('/api/clients', requireAdmin, (req, res) => {
  const clients = readClients()
  const maxId = clients.reduce((m, c) => Math.max(m, c.id), 0)
  const newClient = {
    id: maxId + 1,
    name: '',
    status: 'onboarding',
    product_type: null,
    mood: 3,
    risk_factor: 0,
    listings: 0,
    features: {
      ai_cs: false, ai_sales: false, crm: false, tasks: false,
      auto_msgs: false, auto_tasks: false, website: false, direct_book: false,
      store: false, guest_exp: false, reviews: false, iot: false, damage_waiver: false
    },
    notes: '',
    ...req.body
  }
  clients.push(newClient)
  writeClients(clients)
  res.json(newClient)
})

app.delete('/api/clients/:id', requireAdmin, (req, res) => {
  const clients = readClients()
  const idx = clients.findIndex(c => c.id === parseInt(req.params.id))
  if (idx === -1) return res.status(404).json({ error: 'Not found' })
  clients.splice(idx, 1)
  writeClients(clients)
  res.json({ success: true })
})

// ─── Pending CS bot API ─────────────────────────────────────────────────────
// Report data for the preview page. Falls back to sample data when GitHub
// isn't configured (or ?sample=1 is passed) so the portal always renders.
app.get('/api/pending-cs', requireAuth, async (req, res) => {
  const cfg = pendingCs.getConfig()
  const meta = {
    githubConfigured: pendingCs.isGithubConfigured(cfg),
    slackConfigured: pendingCs.isSlackConfigured(cfg),
    scheduleEnabled: pendingCs.isEnabled(cfg),
    schedule: cfg.schedule,
    tz: cfg.tz,
    channel: cfg.channel
  }
  try {
    // Live fetch scans the whole project board (~2 min), so only do it when
    // explicitly asked (?live=1). Default to fast sample data for page loads.
    const wantLive = req.query.live === '1' && meta.githubConfigured
    const report = wantLive ? await pendingCs.generateReport(cfg) : pendingCs.sampleReport()
    res.json({ ...meta, sample: Boolean(report.sample), report })
  } catch (err) {
    console.error('[pending-cs] preview failed:', err.message)
    res.status(502).json({ ...meta, error: err.message, report: pendingCs.sampleReport(), sample: true })
  }
})

// Manual "send to Slack now" — admin only.
app.post('/api/pending-cs/send', requireAdmin, async (_req, res) => {
  const cfg = pendingCs.getConfig()
  if (!pendingCs.isGithubConfigured(cfg)) return res.status(400).json({ error: 'GitHub is not configured (GITHUB_TOKEN / GITHUB_PROJECT_OWNER / GITHUB_PROJECT_NUMBER).' })
  if (!pendingCs.isSlackConfigured(cfg)) return res.status(400).json({ error: 'Slack is not configured (SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL).' })
  try {
    const { report, result } = await pendingCs.runDailyReport(cfg)
    console.log(`[pending-cs] manual send by ${_req.session.user.username} → ${report.totalTickets} tickets`)
    res.json({ success: true, via: result.via, totalTickets: report.totalTickets, unassignedCount: report.unassignedCount })
  } catch (err) {
    console.error('[pending-cs] manual send failed:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ─── Static ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))

// ─── Pending CS daily scheduler ──────────────────────────────────────────────
;(function schedulePendingCs() {
  const cfg = pendingCs.getConfig()
  if (!pendingCs.isEnabled(cfg)) {
    console.log('[pending-cs] scheduler idle (set GITHUB_TOKEN + GITHUB_PROJECT_OWNER/NUMBER + Slack creds, or PENDING_CS_ENABLED=true).')
    return
  }
  if (!cron.validate(cfg.schedule)) {
    console.error(`[pending-cs] invalid PENDING_CS_SCHEDULE "${cfg.schedule}" — scheduler not started.`)
    return
  }
  cron.schedule(cfg.schedule, async () => {
    try {
      const { report } = await pendingCs.runDailyReport(cfg)
      console.log(`[pending-cs] daily report posted → ${report.totalTickets} tickets (${report.unassignedCount} unassigned).`)
    } catch (err) {
      console.error('[pending-cs] daily report failed:', err.message)
    }
  }, { timezone: cfg.tz })
  console.log(`[pending-cs] scheduled "${cfg.schedule}" (${cfg.tz}) → channel ${cfg.channel}.`)
})()

app.listen(PORT, () => {
  console.log(`Boom Ops portal running → http://localhost:${PORT}`)
})
