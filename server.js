const express = require('express')
const session = require('express-session')
const fs = require('fs')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3002

// ─── Credentials ─────────────────────────────────────────────────────────────
// Set VIEWER_USER, VIEWER_PASS, ADMIN_USER, ADMIN_PASS in Railway env vars.
// The values below are defaults for local development only.
const USERS = {
  [process.env.VIEWER_USER || 'viewer']: {
    password: process.env.VIEWER_PASS || 'viewer123',
    role: 'viewer'
  },
  [process.env.ADMIN_USER || 'admin']: {
    password: process.env.ADMIN_PASS || 'admin123',
    role: 'admin'
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(session({
  secret: process.env.SESSION_SECRET || 'boom-report-secret-change-this',
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

// ─── Static ───────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')))

app.listen(PORT, () => {
  console.log(`Boom Ops portal running → http://localhost:${PORT}`)
})
