require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const ROLES = ['dispatcher', 'field', 'hospital', 'authority'];
const CATEGORIES = ['Fire', 'Flood', 'Medical', 'Accident', 'Gas leak', 'Chemical', 'Tree fall', 'Power', 'Other'];
const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const STATUSES = ['New', 'Assigned', 'En route', 'On scene', 'Resolved'];
const SOURCES = ['citizen', 'call', 'sensor', 'field'];
const PRIORITY = { Critical: 1, High: 2, Medium: 3, Low: 4 };
const SEV_SCORE = { Low: 2.5, Medium: 4.8, High: 6.8, Critical: 9.0 }; // for the 0-10 severity bar

const MERGE_RADIUS_KM = 1;      // reports closer than this can be the same incident
const MERGE_WINDOW_HOURS = 3;   // ...if they arrive within this time
const DELAY_ALERT_MIN = 12;     // assigned incident silent this long -> escalation alert

const app = express();
app.use(cors());
app.use(express.json());
// Serves public/index.html (the login page) and public/dispatcher.html (console)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  const login = path.join(__dirname, 'public', 'login.html');
  res.sendFile(fs.existsSync(login) ? login : path.join(__dirname, 'public', 'dispatcher.html'));
});
app.get('/console', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dispatcher.html')));

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
const db = new sqlite3.Database('./emergency.db', (err) => {
  if (err) console.error(err.message);
  else console.log('Connected to SQLite database.');
});

// Small promise wrappers so we can use async/await
const run = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))));
const all = (sql, params = []) =>
  new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

async function addColumnIfMissing(table, column, definition) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const min = (m) => m * 60 * 1000;
const ago = (m) => new Date(Date.now() - min(m)).toISOString();
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    description TEXT,
    category TEXT,
    severity TEXT,
    lat REAL,
    lng REAL,
    resources TEXT,
    is_duplicate INTEGER DEFAULT 0
  )`);
  await run(`CREATE TABLE IF NOT EXISTS incident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER,
    description TEXT,
    lat REAL,
    lng REAL,
    source TEXT,
    created_at TEXT
  )`);
  /* Dispatcher-console layer */
  await run(`CREATE TABLE IF NOT EXISTS units (
    id TEXT PRIMARY KEY,
    kind TEXT, name TEXT, base TEXT, status TEXT,
    capabilities TEXT, crew INTEGER, fuel INTEGER,
    lat REAL, lng REAL, speed_kmh REAL,
    incident_id INTEGER, eta_ts INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER, unit_id TEXT, eta_min INTEGER,
    assigned_at TEXT, status TEXT DEFAULT 'enroute'
  )`);
  await run(`CREATE TABLE IF NOT EXISTS facilities (
    id TEXT PRIMARY KEY, name TEXT, lat REAL, lng REAL, trauma INTEGER, beds INTEGER
  )`);
  await run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id INTEGER, kind TEXT, status TEXT, action TEXT,
    message TEXT, created_at TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT, recipient TEXT, message TEXT, incident_id INTEGER, created_at TEXT
  )`);
await run(`CREATE TABLE IF NOT EXISTS hospital_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  facility_id TEXT NOT NULL,
  status TEXT DEFAULT 'pre-alert',
  triage TEXT DEFAULT 'unknown',
  department TEXT DEFAULT 'Emergency',
  beds_requested INTEGER DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(incident_id, facility_id)
)`);
  // Upgrade an existing emergency.db from older versions without deleting it
await addColumnIfMissing('users', 'role', "TEXT DEFAULT 'dispatcher'");
await addColumnIfMissing('users', 'display_name', 'TEXT');
await addColumnIfMissing('users', 'facility_id', 'TEXT');
  await addColumnIfMissing('incidents', 'summary', 'TEXT');
  await addColumnIfMissing('incidents', 'priority', 'INTEGER DEFAULT 3');
  await addColumnIfMissing('incidents', 'status', "TEXT DEFAULT 'New'");
  await addColumnIfMissing('incidents', 'report_count', 'INTEGER DEFAULT 1');
  await addColumnIfMissing('incidents', 'source', "TEXT DEFAULT 'citizen'");
  await addColumnIfMissing('incidents', 'created_at', 'TEXT');
  await addColumnIfMissing('incidents', 'updated_at', 'TEXT');
  await addColumnIfMissing('incidents', 'severity_score', 'REAL DEFAULT 0');
  await addColumnIfMissing('incidents', 'ai_confidence', 'REAL DEFAULT 0');
  await addColumnIfMissing('incidents', 'casualties_total', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('incidents', 'casualties_serious', 'INTEGER DEFAULT 0');
  await addColumnIfMissing('incidents', 'details', "TEXT DEFAULT '{}'");
  await addColumnIfMissing('incidents', 'area', 'TEXT');
  await addColumnIfMissing('incidents', 'assigned_at', 'TEXT');
  await addColumnIfMissing('incidents', 'escalated', 'INTEGER DEFAULT 0');

  await seedDemoUsers();
  await seedWorld();
}

// Demo accounts used by the one-click chips on the login page.
// Remove this before any real deployment.
async function seedDemoUsers() {
  const demo = [
    ['DSP-2041', 'dispatcher', 'Control room dispatcher'],
    ['FIRE-07', 'field', 'Fire team 07'],
    ['HSP-118', 'hospital', 'City hospital'],
    ['collector@district.gov.in', 'authority', 'District authority'],
  ];
  const hash = await bcrypt.hash('demo-access', 10);
  for (const [username, role, displayName] of demo) {
    await run(
      `INSERT OR IGNORE INTO users (username, password, role, display_name) VALUES (?, ?, ?, ?)`,
      [username, hash, role, displayName]
    );
  }
  await run(`
  UPDATE users
  SET facility_id = 'H01'
  WHERE username = 'HSP-118'
    AND role = 'hospital'
`);
}

/* Synthetic world seed — only when the DB is empty (first run / fresh demo) */
async function seedWorld() {
  const n = await get(`SELECT COUNT(*) AS n FROM units`);
  if (!n.n) {
    const U = (id, kind, name, base, status, caps, crew, fuel, lat, lng, speed) =>
      run(`INSERT INTO units (id,kind,name,base,status,capabilities,crew,fuel,lat,lng,speed_kmh) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, kind, name, base, status, JSON.stringify(caps), crew, fuel, lat, lng, speed]);
    /* Ambulances 6/10 free */
    await U('A12', 'ambulance', 'Ambulance A12', 'EMS Depot 2', 'available', ['als', 'paramedics'], 2, 78, 22.9600, 72.5900, 45);
    await U('A09', 'ambulance', 'Ambulance A09', 'EMS Depot 1', 'available', ['als', 'paramedics'], 2, 64, 22.9200, 72.5500, 45);
    await U('A02', 'ambulance', 'Ambulance A02', 'EMS Depot 3', 'available', ['bls'], 2, 81, 23.0110, 72.5520, 45);
    await U('A05', 'ambulance', 'Ambulance A05', 'EMS Depot 2', 'available', ['bls'], 2, 55, 22.9000, 72.6300, 45);
    await U('A08', 'ambulance', 'Ambulance A08', 'EMS Depot 4', 'available', ['als'], 2, 70, 23.0300, 72.6000, 45);
    await U('A11', 'ambulance', 'Ambulance A11', 'EMS Depot 1', 'available', ['bls'], 2, 88, 22.9400, 72.5600, 45);
    await U('A03', 'ambulance', 'Ambulance A03', 'EMS Depot 3', 'enroute', ['als'], 2, 47, 22.9850, 72.5450, 45);
    await U('A14', 'ambulance', 'Ambulance A14', 'EMS Depot 4', 'onscene', ['bls'], 2, 39, 22.9620, 72.5980, 45);
    await U('A01', 'ambulance', 'Ambulance A01', 'EMS Depot 1', 'onscene', ['als'], 2, 52, 22.9555, 72.6105, 45);
    await U('A06', 'ambulance', 'Ambulance A06', 'EMS Depot 2', 'standby', ['bls'], 2, 18, 22.9780, 72.5700, 45);
    /* Police 4/8 free */
    await U('P07', 'police', 'Police P07', 'Highway Patrol', 'available', ['traffic', 'scene'], 3, 66, 23.0260, 72.6360, 50);
    await U('P03', 'police', 'Police P03', 'Station 1', 'available', ['traffic'], 2, 74, 22.9400, 72.6500, 50);
    await U('P11', 'police', 'Police P11', 'Station 3', 'available', ['scene'], 2, 61, 22.9300, 72.5400, 50);
    await U('P15', 'police', 'Police P15', 'Station 4', 'available', ['traffic'], 2, 69, 23.0400, 72.6400, 50);
    await U('P02', 'police', 'Police P02', 'Station 1', 'onscene', ['scene'], 2, 44, 22.9560, 72.6010, 50);
    await U('P05', 'police', 'Police P05', 'Station 2', 'onscene', ['traffic'], 2, 37, 22.9640, 72.5870, 50);
    await U('P09', 'police', 'Police P09', 'Station 3', 'enroute', ['scene'], 2, 58, 23.0140, 72.5920, 50);
    await U('P12', 'police', 'Police P12', 'Station 4', 'onscene', ['traffic'], 2, 41, 22.9480, 72.5930, 50);
    /* Fire 2/5 free */
    await U('F05', 'fire', 'Fire Tender F05', 'Station 1', 'available', ['water', 'foam'], 4, 83, 23.0500, 72.5600, 40);
    await U('F06', 'fire', 'Fire Tender F06', 'Station 5', 'available', ['water'], 4, 77, 23.0700, 72.6200, 40);
    await U('F02', 'fire', 'Fire Tender F02', 'Station 4', 'standby', ['foam', 'hazmat'], 4, 91, 22.9320, 72.6680, 40);
    await U('F01', 'fire', 'Fire Tender F01', 'Station 2', 'onscene', ['water', 'pump'], 4, 40, 22.9570, 72.6060, 40);
    await U('F03', 'fire', 'Fire Tender F03', 'Station 3', 'onscene', ['water'], 4, 35, 22.9600, 72.5900, 40);
    /* Rescue 3/6 free */
    await U('R03', 'rescue', 'Rescue Team R03', 'Central Depot', 'available', ['extrication', 'rope'], 4, 85, 22.9350, 72.6450, 42);
    await U('R05', 'rescue', 'Rescue Team R05', 'Depot 2', 'available', ['boat', 'rope'], 4, 79, 23.0200, 72.5300, 42);
    await U('R06', 'rescue', 'Rescue Team R06', 'Depot 3', 'available', ['extrication'], 4, 72, 22.9100, 72.5600, 42);
    await U('R01', 'rescue', 'Rescue Team R01', 'Central Depot', 'onscene', ['boat'], 4, 46, 22.9510, 72.6090, 42);
    await U('R02', 'rescue', 'Rescue Team R02', 'Depot 2', 'onscene', ['extrication'], 4, 43, 22.9615, 72.5955, 42);
    await U('R04', 'rescue', 'Rescue Team R04', 'Depot 3', 'enroute', ['rope'], 4, 57, 23.0170, 72.6040, 42);
    /* Utility */
    await U('U01', 'utility', 'Utility Crew U01', 'Municipal Yard', 'enroute', ['electrical'], 3, 62, 22.9800, 72.5850, 38);
    await U('U02', 'utility', 'Utility Crew U02', 'Municipal Yard', 'available', ['electrical'], 3, 80, 22.9950, 72.5720, 38);

    await run(`INSERT INTO facilities (id,name,lat,lng,trauma,beds) VALUES ('H01','Trauma Centre Ahmedabad',23.0320,72.6350,1,14)`);
    await run(`INSERT INTO facilities (id,name,lat,lng,trauma,beds) VALUES ('H02','Civil Hospital Nadiad',22.6940,72.8620,0,31)`);
    await run(`INSERT INTO facilities (id,name,lat,lng,trauma,beds) VALUES ('H03','GCS Medical College',23.0400,72.5900,1,8)`);
  }

  const c = await get(`SELECT COUNT(*) AS n FROM incidents`);
  if (!c.n) {
    const I = async (title, category, severity, score, status, lat, lng, area, details, casT, casS, createdMin, conf, reports) => {
      const r = await run(
        `INSERT INTO incidents
          (title, description, summary, category, severity, priority, lat, lng, resources, status,
           report_count, source, created_at, updated_at, severity_score, ai_confidence,
           casualties_total, casualties_serious, details, area)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          title, reports[0][1],
          buildSummary(category, reports[0][1], { casualties: { total: casT, serious: casS } }, details),
          category, severity, PRIORITY[severity], lat, lng,
          defaultResources(category), status, reports.length, reports[0][0],
          ago(createdMin), ago(createdMin), score, conf, casT, casS, JSON.stringify(details), area,
        ]);
      for (const [source, text, m] of reports) {
        await run(`INSERT INTO incident_reports (incident_id, description, lat, lng, source, created_at) VALUES (?,?,?,?,?,?)`,
          [r.lastID, text, lat, lng, source, ago(m)]);
      }
      return r.lastID;
    };
    const crashId = await I('Multi-vehicle crash — NH48 km 42 northbound', 'Accident', 'Critical', 9.2, 'New',
      22.9850, 72.6100, 'NH48', { lanesBlocked: 2, fuelSpillRisk: true }, 4, 2, 6, 0.94, [
        ['call', 'Multi-vehicle crash on NH48 km 42, four injured, tanker involved', 6],
        ['citizen', 'Big collision NH48 km 42 northbound, people trapped in car', 5],
        ['sensor', 'Camera C-118: multiple vehicles blocked lane northbound km 42', 4],
        ['citizen', 'Accident near km 42 NH48, four injured asking ambulance', 1],
      ]);
    const floodId = await I('Flood, Sector 4', 'Flood', 'Critical', 8.4, 'Assigned',
      22.9560, 72.6050, 'Sector 4', { waterLevelM: 4.8, housesAffected: 6 }, 0, 0, 18, 0.91, [
        ['sensor', 'River sensor S-07 crossed danger level 4.8m', 18],
        ['field', 'Water rising fast in Sector 4 low layout, 6 houses affected', 16],
      ]);
    await I('Gas leak, Industrial Zone', 'Gas leak', 'High', 6.8, 'New',
      22.9740, 72.6340, 'Industrial Zone', { lePercent: 42, evacuationProposedM: 500 }, 0, 0, 11, 0.89, [
        ['sensor', 'Gas sensor G-07 leak concentration 42% LEL rising', 11],
      ]);
    await I('Warehouse fire, Dock 3', 'Fire', 'High', 7.1, 'Assigned',
      22.9615, 72.5955, 'Dock 3', { containedPercent: 60 }, 1, 0, 26, 0.93, [
        ['call', 'Warehouse on fire at Dock 3, heavy smoke', 26],
        ['citizen', 'Fire burning at logistics dock 3 see flames', 25],
        ['field', 'Warehouse fire dock 3, spreading to pallets', 24],
      ]);
    await I('Tree fall, Market Road', 'Tree fall', 'Medium', 4.2, 'Assigned',
      22.9830, 72.5660, 'Market Road', {}, 0, 0, 34, 0.97, [
        ['citizen', 'Tree fell on Market Road blocking traffic', 34],
      ]);
    await I('River sensor S-07 danger level', 'Flood', 'Low', 2.6, 'New',
      22.9510, 72.6090, 'Sector 4', { waterLevelM: 4.3 }, 0, 0, 41, 0.99, [
        ['sensor', 'River sensor S-07 crossed danger level', 41],
      ]);
    await I('Power line down, Ring Road', 'Power', 'Medium', 4.6, 'Assigned',
      22.9800, 72.5850, 'Ring Road', {}, 0, 0, 48, 0.95, [
        ['citizen', 'Power line down sparking on Ring Road', 48],
      ]);
    await I('Chemical smell, Dock 5', 'Chemical', 'Low', 3.1, 'New',
      22.9660, 72.5900, 'Dock 5', {}, 0, 0, 52, 0.72, [
        ['field', 'Chemical smell near Dock 5 gate, verifying source', 52],
      ]);

    /* units already responding to seeded incidents */
    const A = (incidentId, unitId, eta, status, m) =>
      run(`INSERT INTO assignments (incident_id, unit_id, eta_min, assigned_at, status) VALUES (?,?,?,?,?)`,
        [incidentId, unitId, eta, ago(m), status]);
    await A(floodId, 'R01', 9, 'onscene', 15); await A(floodId, 'F01', 12, 'onscene', 15);
    await run(`UPDATE units SET status='onscene', incident_id=? WHERE id IN ('R01','F01')`, [floodId]);
    const fireId = crashId + 3; // warehouse fire is 4th seeded incident
    await A(fireId, 'F03', 8, 'onscene', 24); await A(fireId, 'R02', 10, 'onscene', 24); await A(fireId, 'A14', 11, 'onscene', 23);
    await run(`UPDATE units SET status='onscene', incident_id=? WHERE id IN ('F03','R02','A14')`, [fireId]);
    const treeId = crashId + 4, powerId = crashId + 6;
    await A(treeId, 'P03', 6, 'onscene', 30); await run(`UPDATE units SET status='onscene', incident_id=? WHERE id='P03'`, [treeId]);
    await A(powerId, 'U01', 9, 'enroute', 44); await run(`UPDATE units SET status='enroute', incident_id=? WHERE id='U01'`, [powerId]);

    await run(`INSERT INTO alerts (incident_id, kind, status, action, message, created_at) VALUES (?,?,?,?,?,?)`,
      [floodId, 'delay', 'active', 'escalate', 'Flood, Sector 4 — no update from Team T-06 for 12 min. SLA breach in 3 min.', ago(2)]);
    const gasId = crashId + 2;
    await run(`INSERT INTO alerts (incident_id, kind, status, action, message, created_at) VALUES (?,?,?,?,?,?)`,
      [gasId, 'evacuation', 'active', 'approve', 'Gas leak — AI proposes 500 m evacuation radius + road closure.', ago(3)]);
  }
}

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */
function auth(allowedRoles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Sign in required' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Session expired. Sign in again.' });
    }
    if (allowedRoles.length && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your role cannot do this' });
    }
    next();
  };
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Enter your ID and password' });

    const user = await get(`SELECT * FROM users WHERE lower(username) = lower(?)`, [username]);
    const valid = user && (await bcrypt.compare(password, user.password));
    if (!valid) return res.status(401).json({ error: 'Invalid ID or password' });

    // The role tab picked on the login page must match the account
    if (role && role !== user.role) {
      return res.status(403).json({ error: `This account is not a ${role} account. Pick the ${user.role} tab.` });
    }

    const payload = {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.display_name || user.username,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });
    res.json({ message: 'Login successful', token, user: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Only signed-in authority users can create accounts (no public sign-up for staff)
app.post('/api/register', auth(['authority']), async (req, res) => {
  try {
    const { username, password, role, displayName } = req.body;
    if (!username || !password || !ROLES.includes(role)) {
      return res.status(400).json({ error: 'Username, password and a valid role are required' });
    }
    const hash = await bcrypt.hash(password, 10);
    const result = await run(
      `INSERT INTO users (username, password, role, display_name) VALUES (?, ?, ?, ?)`,
      [username, hash, role, displayName || username]
    );
    res.status(201).json({ message: 'User registered', userId: result.lastID });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That ID already exists' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/me', auth(), (req, res) => res.json({ user: req.user }));

// Used by the "All services running" line on the dashboard
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', time: new Date().toISOString(), wsClients: wsClients.size }));

/* ------------------------------------------------------------------ */
/* AI classification (Gemini with offline heuristic fallback)          */
/* ------------------------------------------------------------------ */
const TYPE_RULES = [
  { category: 'Accident',  kw: ['crash', 'collision', 'vehicle', 'accident', 'tanker', 'hit'], base: 5.0 },
  { category: 'Fire',      kw: ['fire', 'flame', 'burning', 'smoke'], base: 6.0 },
  { category: 'Flood',     kw: ['flood', 'water rising', 'overflow', 'danger level', 'submerged'], base: 5.5 },
  { category: 'Gas leak',  kw: ['gas', 'leak', 'odour', 'odor', 'lel'], base: 5.5 },
  { category: 'Chemical',  kw: ['chemical', 'spill', 'toxic', 'fumes'], base: 5.0 },
  { category: 'Tree fall', kw: ['tree', 'branch'], base: 3.0 },
  { category: 'Power',     kw: ['power', 'electric', 'sparking', 'wire'], base: 3.5 },
  { category: 'Medical',   kw: ['cardiac', 'unconscious', 'collapse', 'chest pain', 'stroke'], base: 5.0 },
];
const SEV_KEYWORDS = [
  [/trapped/, 2.0], [/explosion/, 3.0], [/spill/, 1.5], [/rising|fast/, 1.0],
  [/injured|casualt/, 2.0], [/multiple|multi/, 1.0], [/serious|critical/, 1.5], [/blocked/, 0.8],
];
const CASUALTY_RE = /(\d+)\s*(?:people\s*)?(?:injured|casualties|hurt)/i;

const KIND_LABEL = { ambulance: 'Ambulance', police: 'Police Unit', fire: 'Fire Truck', rescue: 'Rescue Team', utility: 'Utility Crew' };
const NEEDS = {
  Accident: (d) => [
    { kind: 'ambulance', checked: true, why: 'casualties on scene' },
    { kind: 'police', checked: true, why: 'traffic control + scene security' },
    { kind: 'rescue', checked: true, why: 'extrication unit' },
    ...(d.fuelSpillRisk ? [{ kind: 'fire', checked: false, why: 'optional (fuel-spill risk)' }] : []),
  ],
  Fire: () => [
    { kind: 'fire', checked: true, why: 'primary attack' },
    { kind: 'rescue', checked: false, why: 'optional (search)' },
    { kind: 'ambulance', checked: false, why: 'optional (burns)' },
  ],
  Flood: () => [
    { kind: 'rescue', checked: true, why: 'boat / swift-water' },
    { kind: 'fire', checked: true, why: 'pump support' },
    { kind: 'police', checked: false, why: 'optional (evacuation)' },
  ],
  'Gas leak': () => [
    { kind: 'fire', checked: true, why: 'hazmat containment' },
    { kind: 'police', checked: true, why: 'cordon + evacuation' },
    { kind: 'ambulance', checked: false, why: 'standby' },
  ],
  Chemical: () => [
    { kind: 'fire', checked: true, why: 'hazmat' },
    { kind: 'rescue', checked: false, why: 'optional (decon)' },
  ],
  'Tree fall': () => [
    { kind: 'rescue', checked: true, why: 'chainsaw crew' },
    { kind: 'police', checked: false, why: 'optional (traffic)' },
  ],
  Power: () => [
    { kind: 'utility', checked: true, why: 'electrical isolation' },
    { kind: 'police', checked: false, why: 'optional (cordon)' },
  ],
  Medical: () => [{ kind: 'ambulance', checked: true, why: 'ALS response' }],
  Other: () => [{ kind: 'police', checked: true, why: 'first response' }],
};
const ACTIONS = {
  Accident: ['Divert NB traffic via exit 4', 'Request crane + foam unit', 'Pre-alert trauma centre'],
  Fire: ['Establish 100 m cordon', 'Request water tanker support', 'Check wind direction for smoke'],
  Flood: ['Activate boat teams', 'Open sector shelter', 'Cut power to affected layout'],
  'Gas leak': ['Approve evacuation radius', 'Close roads in radius', 'Shut zone gas main'],
  Chemical: ['Identify substance via MSDS', 'Set up decon corridor', 'Sample downwind air'],
  'Tree fall': ['Divert traffic', 'Request chainsaw crew', 'Check for wire contact'],
  Power: ['Isolate feeder', 'Cordon spark zone', 'Notify utility control'],
  Medical: ['Pre-alert nearest ER', 'Dispatch ALS ambulance', 'Guide caller through CPR'],
  Other: ['Send nearest patrol', 'Verify with camera feed'],
};
function defaultResources(category) {
  const needs = (NEEDS[category] || NEEDS.Other)({});
  return needs.filter((n) => n.checked).map((n) => `1 ${KIND_LABEL[n.kind]}`).join(', ') || '1 Police Unit';
}

/* Offline heuristic classifier (used when GEMINI_API_KEY is absent or the API fails) */
function heuristicClassify(description) {
  const text = description.toLowerCase();
  let best = { category: 'Other', base: 3.0, hits: 0 };
  for (const r of TYPE_RULES) {
    const hits = r.kw.filter((k) => text.includes(k)).length;
    if (hits > best.hits) best = { ...r, hits };
  }
  let score = best.base;
  for (const [re, w] of SEV_KEYWORDS) if (re.test(text)) score += w;
  score = Math.max(0.5, Math.min(10, score + rnd(-0.3, 0.3)));
  const severity = score >= 8 ? 'Critical' : score >= 6 ? 'High' : score >= 4 ? 'Medium' : 'Low';
  const m = description.match(CASUALTY_RE);
  const total = m ? parseInt(m[1], 10) : /injured|casualt|hurt/i.test(description) ? 1 : 0;
  const serious = total ? Math.max(total >= 4 ? 2 : 1, Math.floor(total / 3)) : 0;
  return {
    category: best.category, severity, severityScore: round1(score),
    casualties: { total, serious },
    confidence: round2(Math.min(0.99, 0.7 + best.hits * 0.08 + rnd(0, 0.08))),
    resources: defaultResources(best.category),
    actions: ACTIONS[best.category] || ACTIONS.Other,
    aiUsed: false,
  };
}

async function classify(description) {
  if (!process.env.GEMINI_API_KEY) return heuristicClassify(description);
  const prompt = `You are an emergency dispatcher assistant. Analyze this report: "${description}"
Respond ONLY with a JSON object in this exact schema:
{
  "category": "${CATEGORIES.join('" | "')}",
  "severity": "Low" | "Medium" | "High" | "Critical",
  "resources": "comma-separated recommended units, e.g. 2 Fire Trucks, 1 Ambulance",
  "summary": "one short sentence a responder can read in 3 seconds",
  "casualties_total": 0,
  "casualties_serious": 0,
  "actions": ["short suggested action", "short suggested action"]
}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      }
    );
    if (!r.ok) throw new Error(`Gemini responded with HTTP ${r.status}`);
    const data = await r.json();
    const p = JSON.parse(data.candidates?.[0]?.content?.parts?.[0]?.text);
    const h = heuristicClassify(description); // still used for score/confidence
    // Never trust model output blindly: keep only allowed values
    return {
      category: CATEGORIES.includes(p.category) ? p.category : h.category,
      severity: SEVERITIES.includes(p.severity) ? p.severity : h.severity,
      severityScore: round2(Math.min(10, SEVERITIES.includes(p.severity) ? SEV_SCORE[p.severity] + rnd(-0.3, 0.3) : h.severityScore)),
      resources: typeof p.resources === 'string' && p.resources ? p.resources : h.resources,
      summary: typeof p.summary === 'string' && p.summary ? p.summary : '',
      casualties: {
        total: Number.isInteger(p.casualties_total) ? p.casualties_total : h.casualties.total,
        serious: Number.isInteger(p.casualties_serious) ? p.casualties_serious : h.casualties.serious,
      },
      actions: Array.isArray(p.actions) && p.actions.length ? p.actions.slice(0, 4) : h.actions,
      confidence: 0.95,
      aiUsed: true,
    };
  } catch (e) {
    console.warn('AI fallback used:', e.message);
    return heuristicClassify(description);
  }
}

/* NLG summary (template) — ML HOOK: replace with an LLM call over incident reports */
function buildSummary(category, description, ai, details = {}) {
  const parts = [`${category} report: ${description.slice(0, 110)}.`];
  if (ai.casualties.total) parts.push(`${ai.casualties.total} casualties${ai.casualties.serious ? `, ${ai.casualties.serious} serious` : ''}.`);
  if (details.lanesBlocked) parts.push(`${details.lanesBlocked} of 3 lanes blocked.`);
  if (details.fuelSpillRisk) parts.push('Tanker involved with fuel-spill risk.');
  if (details.waterLevelM) parts.push(`Water level ${details.waterLevelM} m.`);
  if (details.lePercent) parts.push(`LEL at ${details.lePercent}% and rising.`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ */
/* Geo + resource recommendation                                       */
/* ------------------------------------------------------------------ */
function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const etaMin = (u, lat, lng) =>
  Math.max(2, Math.round((distanceKm(u.lat, u.lng, lat, lng) / u.speed_kmh) * 60 + 1.5));

/* Rank available units per required kind by ETA — ML HOOK: swap for an OR-tools optimiser */
async function recommendResources(incident) {
  let details = {};
  try { details = JSON.parse(incident.details || '{}'); } catch { /* ignore */ }
  const needs = (NEEDS[incident.category] || NEEDS.Other)(details);
  const out = [];
  for (const need of needs) {
    const candidates = (await all(
      `SELECT * FROM units WHERE kind = ? AND status IN ('available','standby')`, [need.kind]))
      .map((u) => ({ u, eta: etaMin(u, incident.lat, incident.lng) }))
      .sort((a, b) => a.eta - b.eta);
    const c = candidates[0];
    if (c) {
      out.push({
        unitId: c.u.id, kind: c.u.kind, name: c.u.name, base: c.u.base,
        capabilities: JSON.parse(c.u.capabilities || '[]'), crew: c.u.crew, fuel: c.u.fuel,
        status: c.u.status, etaMin: c.eta, checked: need.checked, reason: need.why,
      });
    }
  }
  return out;
}

async function nearestHospital(lat, lng) {
  const rows = await all(`SELECT * FROM facilities WHERE trauma = 1`);
  if (!rows.length) return null;
  const h = rows
    .map((x) => ({ ...x, etaMin: Math.max(3, Math.round((distanceKm(x.lat, x.lng, lat, lng) / 40) * 60)) }))
    .sort((a, b) => a.etaMin - b.etaMin)[0];
  return { id: h.id, name: h.name, etaMin: h.etaMin, beds: h.beds };
}

/* ------------------------------------------------------------------ */
/* WebSocket hub (role-aware live feed)                                */
/* ------------------------------------------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

function broadcast(type, payload, publicSafe = false) {
  const msg = JSON.stringify({ type, ts: Date.now(), payload });
  for (const c of wsClients) {
    if (c.readyState !== 1) continue;
    if (!publicSafe && !c.user) continue; // staff-only events need a valid JWT on the socket
    c.send(msg);
  }
}

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (token) {
    try { socket.user = jwt.verify(token, JWT_SECRET); } catch { /* anonymous */ }
  }
  wsClients.add(socket);
  (async () => {
    if (socket.user) {
      socket.send(JSON.stringify({
        type: 'hello', ts: Date.now(),
        payload: {
          user: { username: socket.user.username, role: socket.user.role },
          incidents: await all(`SELECT * FROM incidents ORDER BY priority ASC, id DESC`),
          units: await all(`SELECT * FROM units`),
          facilities: await all(`SELECT * FROM facilities`),
          alerts: await all(`SELECT * FROM alerts WHERE status = 'active'`),
          notifications: await all(`SELECT * FROM notifications ORDER BY id DESC LIMIT 10`),
        },
      }));
    } else {
      socket.send(JSON.stringify({
        type: 'hello', ts: Date.now(),
        payload: { anonymous: true, note: 'Connect with ?token=<JWT> for the full staff feed' },
      }));
    }
  })();
  socket.on('close', () => wsClients.delete(socket));
});

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
async function getHospitalFacility(req) {
  return await get(`
    SELECT f.*
    FROM users u
    JOIN facilities f ON f.id = u.facility_id
    WHERE u.id = ?
      AND u.role = 'hospital'
  `, [req.user.id]);
}

async function notify(channel, recipient, message, incidentId = null) {
  const r = await run(
    `INSERT INTO notifications (channel, recipient, message, incident_id, created_at) VALUES (?,?,?,?,?)`,
    [channel, recipient, message, incidentId, new Date().toISOString()]);
  const n = { id: r.lastID, channel, recipient, message, incidentId, created_at: new Date().toISOString() };
  broadcast('notification.sent', n);
  return n;
}

/* ------------------------------------------------------------------ */
/* Ingestion: NEW INCIDENT -> AI CLASSIFICATION -> DEDUPE -> (create|merge) */
/* ------------------------------------------------------------------ */
async function ingestReport({ description, lat, lng, source = 'citizen', details }) {
  const ai = await classify(description);
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - MERGE_WINDOW_HOURS * 3600 * 1000).toISOString();

  // Duplicate detection: same category, within 1 km, recent, not resolved
  const candidates = await all(
    `SELECT * FROM incidents WHERE status != 'Resolved' AND category = ? AND created_at >= ?`,
    [ai.category, since]
  );
  const match = candidates.find((i) => distanceKm(i.lat, i.lng, lat, lng) <= MERGE_RADIUS_KM);

  if (match) {
    // Merge into the existing incident instead of creating a new one
    const count = (match.report_count || 1) + 1;
    let severity = match.severity;
    if (SEVERITIES.indexOf(ai.severity) > SEVERITIES.indexOf(severity)) severity = ai.severity;
    // Many independent reports usually mean it is bigger than first thought
    if (count === 3 && severity !== 'Critical') severity = SEVERITIES[SEVERITIES.indexOf(severity) + 1];
    const score = round1(Math.min(10, (match.severity_score || SEV_SCORE[severity]) + 0.2));

    await run(
      `UPDATE incidents SET report_count = ?, severity = ?, priority = ?, severity_score = ?, updated_at = ? WHERE id = ?`,
      [count, severity, PRIORITY[severity], score, nowIso, match.id]
    );
    await run(
      `INSERT INTO incident_reports (incident_id, description, lat, lng, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [match.id, description, lat, lng, source, nowIso]
    );
    const merged = await get(`SELECT * FROM incidents WHERE id = ?`, [match.id]);
    broadcast('incident.merged', { incidentId: match.id, reportCount: count, category: ai.category }, false);
    broadcast('incident.updated', merged, false);
    return { merged: true, aiUsed: ai.aiUsed, incident: merged };
  }

  const summary = ai.summary || buildSummary(ai.category, description, ai, details || {});
  const result = await run(
    `INSERT INTO incidents
      (title, description, summary, category, severity, priority, lat, lng, resources, status,
       report_count, source, created_at, updated_at, severity_score, ai_confidence,
       casualties_total, casualties_serious, details, area)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'New', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      description.slice(0, 60), description, summary, ai.category, ai.severity,
      PRIORITY[ai.severity], lat, lng, ai.resources, source, nowIso, nowIso,
      ai.severityScore, ai.confidence, ai.casualties.total, ai.casualties.serious,
      JSON.stringify(details || {}), (details && details.area) || null,
    ]
  );
  await run(
    `INSERT INTO incident_reports (incident_id, description, lat, lng, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [result.lastID, description, lat, lng, source, nowIso]
  );
  const incident = await get(`SELECT * FROM incidents WHERE id = ?`, [result.lastID]);
  const recommendations = await recommendResources(incident);
  broadcast('incident.new', { incident, recommendations }, false);
  if (incident.priority === 1) {
    const a = await run(
      `INSERT INTO alerts (incident_id, kind, status, action, message, created_at) VALUES (?,?,?,?,?,?)`,
      [incident.id, 'critical', 'active', 'assign',
        `${incident.title} classified ${incident.severity.toUpperCase()} (${incident.severity_score}/10). Awaiting dispatch.`, nowIso]);
    broadcast('alert.new', { id: a.lastID, incidentId: incident.id, kind: 'critical', status: 'active', action: 'assign', message: `${incident.title} classified ${incident.severity.toUpperCase()}. Awaiting dispatch.`, created_at: nowIso }, false);
  }
  return { merged: false, aiUsed: ai.aiUsed, incident, recommendations };
}

/* PUBLIC: citizens can report without signing in */
app.post('/api/incidents', async (req, res) => {
  try {
    const description = String(req.body.description || '').trim();
    const lat = Number(req.body.lat);
    const lng = Number(req.body.lng);
    const source = SOURCES.includes(req.body.source) ? req.body.source : 'citizen';

    if (description.length < 5) return res.status(400).json({ error: 'Describe the emergency in a few words' });
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return res.status(400).json({ error: 'A valid location is required' });
    }
    const out = await ingestReport({ description, lat, lng, source, details: req.body.details });
    res.status(out.merged ? 200 : 201).json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not save the report' });
  }
});

/* STAFF ONLY: most urgent first */
app.get('/api/incidents', auth(), async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM incidents ORDER BY priority ASC, id DESC`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* STAFF ONLY: full incident detail for the dispatcher console */
app.get('/api/incidents/:id', auth(), async (req, res) => {
  try {
    const incident = await get(`SELECT * FROM incidents WHERE id = ?`, [req.params.id]);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    const reports = await all(`SELECT * FROM incident_reports WHERE incident_id = ? ORDER BY id`, [incident.id]);
    const assignedUnits = await all(`SELECT * FROM assignments WHERE incident_id = ? ORDER BY id`, [incident.id]);
    const sources = [...new Set(reports.map((r) => r.source))];
    res.json({
      ...incident,
      details: JSON.parse(incident.details || '{}'),
      reports, assignedUnits, sources,
      recommendations: await recommendResources(incident),
      nearestHospital: await nearestHospital(incident.lat, incident.lng),
      suggestedActions: ACTIONS[incident.category] || ACTIONS.Other,
      ageMin: Math.round((Date.now() - new Date(incident.created_at).getTime()) / min(1)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* STAFF: update response status (New, Assigned, En route, On scene, Resolved) */
app.patch('/api/incidents/:id/status', auth(['dispatcher', 'field', 'authority']), async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
    const nowIso = new Date().toISOString();
    const result = await run(`UPDATE incidents SET status = ?, updated_at = ? WHERE id = ?`, [
      status, nowIso, req.params.id,
    ]);
    if (!result.changes) return res.status(404).json({ error: 'Incident not found' });

    if (status === 'Resolved') {
      // release units back to the pool and clear active alerts
      const assigned = await all(`SELECT * FROM units WHERE incident_id = ?`, [req.params.id]);
      for (const u of assigned) {
        await run(`UPDATE units SET status = 'available', incident_id = NULL, eta_ts = NULL WHERE id = ?`, [u.id]);
        broadcast('unit.status', { unitId: u.id, status: 'available', incidentId: Number(req.params.id) }, false);
      }
      await run(`UPDATE alerts SET status = 'resolved' WHERE incident_id = ? AND status = 'active'`, [req.params.id]);
    }
    const incident = await get(`SELECT * FROM incidents WHERE id = ?`, [req.params.id]);
    broadcast('incident.status', { incidentId: incident.id, status }, false);
    broadcast('incident.updated', incident, false);
    res.json(incident);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* Dispatcher actions: ASSIGN / ESCALATE / ALERTS                      */
/* ------------------------------------------------------------------ */
app.post('/api/incidents/:id/assign', auth(['dispatcher', 'authority']), async (req, res) => {
  try {
    const incident = await get(`SELECT * FROM incidents WHERE id = ?`, [req.params.id]);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    const recos = await recommendResources(incident);
    let unitIds = Array.isArray(req.body?.unitIds) ? req.body.unitIds : null;
    if (!unitIds && req.body?.assignAll) unitIds = recos.filter((r) => r.checked).map((r) => r.unitId);
    if (!unitIds || !unitIds.length) return res.status(400).json({ error: 'unitIds[] or assignAll:true required' });

    const nowIso = new Date().toISOString();
    const assigned = [];
    for (const id of unitIds) {
      const u = await get(`SELECT * FROM units WHERE id = ?`, [id]);
      if (!u || !['available', 'standby'].includes(u.status)) continue;
      const eta = etaMin(u, incident.lat, incident.lng);
      await run(`UPDATE units SET status = 'enroute', incident_id = ?, eta_ts = ? WHERE id = ?`,
        [incident.id, Date.now() + min(eta), u.id]);
      await run(`INSERT INTO assignments (incident_id, unit_id, eta_min, assigned_at, status) VALUES (?,?,?,?,?)`,
        [incident.id, u.id, eta, nowIso, 'enroute']);
      assigned.push({ unitId: u.id, name: u.name, etaMin: eta });
      broadcast('unit.status', { unitId: u.id, status: 'enroute', incidentId: incident.id, etaMin: eta }, false);
      await notify('push', u.name, `Dispatched to INC-${incident.id} — ${incident.title}. ETA ${eta} min.`, incident.id);
    }
    if (!assigned.length) return res.status(409).json({ error: 'No requested unit is available' });

    await run(`UPDATE incidents SET status = 'Assigned', assigned_at = ?, updated_at = ? WHERE id = ?`,
      [nowIso, nowIso, incident.id]);
    if ((incident.casualties_serious || 0) > 0) {
      const h = await nearestHospital(incident.lat, incident.lng);
      if (h) await notify('sms', h.name, `Pre-alert: ${incident.casualties_total} casualties (${incident.casualties_serious} serious) en route from ${incident.title}.`, incident.id);
    }
    const updated = await get(`SELECT * FROM incidents WHERE id = ?`, [incident.id]);
    broadcast('incident.assigned', { incidentId: incident.id, assigned }, false);
    broadcast('incident.updated', updated, false);
    const notifications = await all(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`, [assigned.length + 1]);
    res.json({ ok: true, incidentId: incident.id, assigned, notifications });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/incidents/:id/escalate', auth(['dispatcher', 'field']), async (req, res) => {
  try {
    const incident = await get(`SELECT * FROM incidents WHERE id = ?`, [req.params.id]);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    await run(`UPDATE incidents SET escalated = 1, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), incident.id]);
    const n = await notify('radio', 'District Control Room',
      `ESCALATION INC-${incident.id} ${incident.title}. ${req.body?.note || ''}`.trim(), incident.id);
    await run(`UPDATE alerts SET status = 'escalated' WHERE incident_id = ? AND kind = 'delay' AND status = 'active'`, [incident.id]);
    broadcast('incident.updated', await get(`SELECT * FROM incidents WHERE id = ?`, [incident.id]), false);
    res.json({ ok: true, escalated: true, notification: n });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/alerts', auth(), async (_req, res) => {
  res.json(await all(`SELECT * FROM alerts WHERE status = 'active' ORDER BY id DESC`));
});

app.post('/api/alerts/:id/approve', auth(['dispatcher', 'authority']), async (req, res) => {
  try {
    const al = await get(`SELECT * FROM alerts WHERE id = ?`, [req.params.id]);
    if (!al) return res.status(404).json({ error: 'Alert not found' });
    await run(`UPDATE alerts SET status = 'approved' WHERE id = ?`, [al.id]);
    if (al.kind === 'evacuation' && al.incident_id) {
      const inc = await get(`SELECT * FROM incidents WHERE id = ?`, [al.incident_id]);
      if (inc) {
        const details = JSON.parse(inc.details || '{}');
        details.evacuationRadiusM = details.evacuationProposedM || 500;
        await run(`UPDATE incidents SET details = ?, updated_at = ? WHERE id = ?`,
          [JSON.stringify(details), new Date().toISOString(), inc.id]);
        await notify('sms', 'Zone patrols', `Evacuation radius ${details.evacuationRadiusM} m approved for INC-${inc.id}. Close roads in radius.`, inc.id);
        broadcast('incident.updated', await get(`SELECT * FROM incidents WHERE id = ?`, [inc.id]), false);
      }
    }
    const updated = await get(`SELECT * FROM alerts WHERE id = ?`, [al.id]);
    broadcast('alert.resolved', updated, false);
    res.json({ ok: true, alert: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/alerts/:id/resolve', auth(['dispatcher', 'authority']), async (req, res) => {
  const al = await get(`SELECT * FROM alerts WHERE id = ?`, [req.params.id]);
  if (!al) return res.status(404).json({ error: 'Alert not found' });
  await run(`UPDATE alerts SET status = 'resolved' WHERE id = ?`, [al.id]);
  const updated = await get(`SELECT * FROM alerts WHERE id = ?`, [al.id]);
  broadcast('alert.resolved', updated, false);
  res.json({ ok: true, alert: updated });
});

/* ------------------------------------------------------------------ */
/* Resources / hospitals / notifications / analytics                   */
/* ------------------------------------------------------------------ */
app.get('/api/resources', auth(), async (_req, res) => {
  const units = await all(`SELECT * FROM units`);
  const byKind = {};
  for (const u of units) {
    byKind[u.kind] = byKind[u.kind] || { kind: u.kind, total: 0, free: 0, units: [] };
    byKind[u.kind].total++;
    if (u.status === 'available') byKind[u.kind].free++;
    u.capabilities = JSON.parse(u.capabilities || '[]');
    byKind[u.kind].units.push(u);
  }
  res.json(Object.values(byKind));
});

app.get('/api/hospitals', auth(), async (_req, res) => res.json(await all(`SELECT * FROM facilities`)));
// ==================== HOSPITAL DASHBOARD ====================

app.get('/api/hospital/dashboard', auth(['hospital']), async (req, res) => {
  try {
    const hospital = await getHospitalFacility(req);

    if (!hospital) {
      return res.status(404).json({
        error: 'Hospital not linked to a facility'
      });
    }

    const cases = await all(`
      SELECT
        hc.*,
        i.title,
        i.description,
        i.summary,
        i.category,
        i.severity,
        i.status AS incident_status,
        i.casualties_total,
        i.casualties_serious,
        i.created_at AS incident_created_at
      FROM hospital_cases hc
      JOIN incidents i ON i.id = hc.incident_id
      WHERE hc.facility_id = ?
      ORDER BY hc.id DESC
    `, [hospital.id]);

    res.json({
      hospital,
      stats: {
        incoming: cases.filter(c =>
          ['pre-alert', 'accepted', 'ready', 'arrived'].includes(c.status)
        ).length,

        critical: cases.filter(c =>
          c.severity === 'Critical'
        ).length,

        totalCases: cases.length,

        beds: hospital.beds
      },

      cases
    });

  } catch (err) {
    console.error('Hospital dashboard error:', err);

    res.status(500).json({
      error: 'Failed to load hospital dashboard'
    });
  }
});
app.get('/api/notifications', auth(), async (req, res) => {
  const limit = parseInt(req.query.limit || '20', 10);
  const counters = {};
  for (const r of await all(`SELECT channel, COUNT(*) AS n FROM notifications GROUP BY channel`)) counters[r.channel] = r.n;
  res.json({ counters, recent: await all(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`, [limit]) });
});

app.get('/api/analytics', auth(), async (_req, res) => {
  const incidents = await all(`SELECT * FROM incidents`);
  const byCategory = {}, byArea = {};
  let dispatchSum = 0, dispatchN = 0;
  for (const i of incidents) {
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    const area = i.area || 'other';
    byArea[area] = (byArea[area] || 0) + 1;
    if (i.assigned_at) { dispatchSum += (new Date(i.assigned_at) - new Date(i.created_at)) / min(1); dispatchN++; }
  }
  const kinds = await all(`SELECT kind, COUNT(*) AS total, SUM(status = 'available') AS free FROM units GROUP BY kind`);
  res.json({
    incidentsByCategory: byCategory,
    frequentlyAffectedAreas: Object.entries(byArea).sort((a, b) => b[1] - a[1]),
    avgDispatchMin: dispatchN ? round1(dispatchSum / dispatchN) : null,
    activeDelayAlerts: (await get(`SELECT COUNT(*) AS n FROM alerts WHERE kind='delay' AND status='active'`)).n,
    resourceShortages: kinds.filter((k) => k.free / k.total <= 0.45),
    notificationsByChannel: (await get(`SELECT COUNT(*) AS n FROM notifications`)).n,
  });
});

/* ------------------------------------------------------------------ */
/* Simulator — keeps the demo alive (delete when real feeds connect)   */
/* ------------------------------------------------------------------ */
const SENSOR_S07 = { lat: 22.9510, lng: 72.6090 };
let riverLevel = 4.3;

const PHRASES = {
  Accident: ['People trapped after multi-vehicle crash at', 'Ambulance needed, collision at', 'Heavy jam after crash at'],
  Fire: ['Smoke seen again at', 'Flames visible at', 'Fire spreading at'],
  Flood: ['Flood water entering houses at', 'Water rising fast at', 'Road submerged by flood at'],
  'Gas leak': ['Strong gas smell at', 'Leak hissing sound at', 'Gas odour spreading from'],
  Chemical: ['Toxic chemical smell at', 'Chemical spill sighted at', 'Irritating chemical fumes at'],
  'Tree fall': ['Tree branch blocking lane at', 'Tree still across road at', 'Fallen tree blocking traffic at'],
  Power: ['Sparking power wire at', 'Power line hanging at', 'Electric smell near power line at'],
  Medical: ['Person unconscious at', 'Cardiac chest pain reported at', 'Collapse reported at'],
  Other: ['Situation update at'],
};

setInterval(async () => {
  try {
    /* unit ETA progression: enroute -> onscene; all onscene -> incident 'On scene' */
    const due = await all(`SELECT * FROM units WHERE status = 'enroute' AND eta_ts IS NOT NULL AND eta_ts <= ?`, [Date.now()]);
    for (const u of due) {
      await run(`UPDATE units SET status = 'onscene', eta_ts = NULL WHERE id = ?`, [u.id]);
      await run(`UPDATE assignments SET status = 'onscene' WHERE unit_id = ? AND incident_id = ?`, [u.id, u.incident_id]);
      broadcast('unit.status', { unitId: u.id, status: 'onscene', incidentId: u.incident_id }, false);
      if (u.incident_id) {
        const inc = await get(`SELECT * FROM incidents WHERE id = ?`, [u.incident_id]);
        if (inc && inc.status === 'Assigned') {
          const remaining = await get(`SELECT COUNT(*) AS n FROM units WHERE incident_id = ? AND status != 'onscene'`, [inc.id]);
          if (!remaining.n) {
            await run(`UPDATE incidents SET status = 'On scene', updated_at = ? WHERE id = ?`, [new Date().toISOString(), inc.id]);
            broadcast('incident.status', { incidentId: inc.id, status: 'On scene' }, false);
          }
        }
        if (inc) broadcast('incident.updated', inc, false);
      }
    }

    /* river sensor random walk (public-safe event) */
    riverLevel = round1(Math.max(3.5, Math.min(5.6, riverLevel + rnd(-0.12, 0.16))));
    broadcast('sensor.reading', { sensor: 'S-07', levelM: riverLevel, dangerAt: 4.5 }, true);
    if (riverLevel > 5.0) {
      await ingestReport({
        description: `Flood water rising fast, river level ${riverLevel} m at Sector 4`,
        lat: SENSOR_S07.lat, lng: SENSOR_S07.lng, source: 'sensor',
      });
    }

    /* random citizen report — usually about an existing incident (shows merging) */
    if (Math.random() < 0.45) {
      const open = await all(`SELECT * FROM incidents WHERE status IN ('New','Assigned','On scene')`);
      if (open.length) {
        const t = pick(open);
        const text = `${pick(PHRASES[t.category] || PHRASES.Other)} ${t.title.replace(/^[^,—-]+[,—-]\s*/, '')}`;
        await ingestReport({ description: text, lat: t.lat + rnd(-0.002, 0.002), lng: t.lng + rnd(-0.002, 0.002), source: 'citizen' });
      }
    }

    /* delay watchdog: silent assigned incident -> escalation alert */
    const silent = await all(
      `SELECT * FROM incidents WHERE status IN ('Assigned','En route') AND updated_at <= ?`,
      [new Date(Date.now() - min(DELAY_ALERT_MIN)).toISOString()]);
    for (const inc of silent) {
      const has = await get(`SELECT COUNT(*) AS n FROM alerts WHERE incident_id = ? AND kind = 'delay' AND status = 'active'`, [inc.id]);
      if (!has.n) {
        const silentMin = Math.floor((Date.now() - new Date(inc.updated_at).getTime()) / min(1));
        const r = await run(
          `INSERT INTO alerts (incident_id, kind, status, action, message, created_at) VALUES (?,?,?,?,?,?)`,
          [inc.id, 'delay', 'active', 'escalate',
            `${inc.title} — no field update for ${silentMin} min. SLA breach imminent.`, new Date().toISOString()]);
        broadcast('alert.new', { id: r.lastID, incidentId: inc.id, kind: 'delay', status: 'active', action: 'escalate', message: `${inc.title} — no field update for ${silentMin} min.`, created_at: new Date().toISOString() }, false);
      }
    }
  } catch (e) {
    console.error('simulator tick error:', e.message);
  }
}, 6000);

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
initDb()
  .then(() => server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`  Dispatcher console → http://localhost:${PORT}/console`);
    console.log(`  WebSocket          → ws://localhost:${PORT}/ws?token=<JWT>`);
  }))
  .catch((e) => { console.error('Failed to start:', e); process.exit(1); });
