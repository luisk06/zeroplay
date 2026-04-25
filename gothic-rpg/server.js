const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SAVE_FILE = path.join(__dirname, 'save.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function defaultState() {
  return {
    tick: 0, year: 1,
    totalKills: 0, totalDeaths: 0, totalLoot: 0, totalBattles: 0,
    heroes: [], enemies: [], log: [], savedAt: null
  };
}

// ── Local file persistence (used when KV env vars are absent) ──────────────
function loadState() {
  try {
    if (fs.existsSync(SAVE_FILE)) return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  } catch (e) { console.error('Load error:', e.message); }
  return defaultState();
}

function saveState(state) {
  state.savedAt = new Date().toISOString();
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(state, null, 2), 'utf8'); }
  catch (e) { /* read-only fs — ignore */ }
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => res.json(loadState()));

app.post('/api/state', (req, res) => {
  const state = req.body;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'Invalid state' });
  saveState(state);
  res.json({ ok: true, savedAt: state.savedAt });
});

app.post('/api/reset', (req, res) => {
  try { if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE); } catch (e) {}
  res.json(defaultState());
});

app.listen(PORT, () => console.log(`Gothic RPG running at http://localhost:${PORT}`));
