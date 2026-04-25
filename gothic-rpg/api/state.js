const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const WORLD_KEY = 'gothic-rpg:world';

function defaultState() {
  return {
    tick: 0, year: 1,
    totalKills: 0, totalDeaths: 0, totalLoot: 0, totalBattles: 0,
    heroes: [], enemies: [], log: [], savedAt: null
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    try {
      const state = await redis.get(WORLD_KEY);
      return res.status(200).json(state || defaultState());
    } catch (e) {
      console.error('KV get error:', e.message);
      return res.status(200).json(defaultState());
    }
  }

  if (req.method === 'POST') {
    try {
      const state = req.body;
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Invalid state' });
      }
      state.savedAt = new Date().toISOString();
      await redis.set(WORLD_KEY, state);
      return res.status(200).json({ ok: true, savedAt: state.savedAt });
    } catch (e) {
      console.error('KV set error:', e.message);
      return res.status(500).json({ error: 'Save failed' });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
