// Vercel serverless handler for GET /api/state and POST /api/state
// No filesystem persistence on Vercel — always returns a fresh default state.

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

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    return res.status(200).json(defaultState());
  }

  if (req.method === 'POST') {
    // Accept the payload but don't persist (no writable fs on Vercel)
    const savedAt = new Date().toISOString();
    return res.status(200).json({ ok: true, savedAt });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
