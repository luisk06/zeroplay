const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SAVE_FILE = path.join(__dirname, 'save.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Default blank world state
function defaultState() {
  return {
    tick: 0,
    year: 1,
    totalKills: 0,
    totalDeaths: 0,
    totalLoot: 0,
    totalBattles: 0,
    heroes: [],
    enemies: [],
    log: [],
    savedAt: null
  };
}

// Load state from disk, or return default
function loadState() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = fs.readFileSync(SAVE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load save:', e.message);
  }
  return defaultState();
}

// Save state to disk
function saveState(state) {
  state.savedAt = new Date().toISOString();
  fs.writeFileSync(SAVE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// GET /api/state — return current saved state
app.get('/api/state', (req, res) => {
  res.json(loadState());
});

// POST /api/state — save current state from client
app.post('/api/state', (req, res) => {
  const state = req.body;
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ error: 'Invalid state' });
  }
  saveState(state);
  res.json({ ok: true, savedAt: state.savedAt });
});

// POST /api/reset — wipe save file and return fresh state
app.post('/api/reset', (req, res) => {
  if (fs.existsSync(SAVE_FILE)) {
    fs.unlinkSync(SAVE_FILE);
  }
  const fresh = defaultState();
  res.json(fresh);
});

app.listen(PORT, () => {
  console.log(`Gothic RPG running at http://localhost:${PORT}`);
});
