// Vercel serverless handler for POST /api/reset

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

  if (req.method === 'POST') {
    return res.status(200).json(defaultState());
  }

  res.status(405).json({ error: 'Method not allowed' });
};
