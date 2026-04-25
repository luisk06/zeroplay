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

  if (req.method === 'POST') {
    try {
      await redis.del(WORLD_KEY);
    } catch (e) {
      console.error('KV del error:', e.message);
    }
    return res.status(200).json(defaultState());
  }

  res.status(405).json({ error: 'Method not allowed' });
};
