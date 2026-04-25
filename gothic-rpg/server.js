const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
//  Persistence helpers (local file, falls back silently when read-only)
// ─────────────────────────────────────────────────────────────────────────────
const SAVE_FILE = path.join(__dirname, 'save.json');

let redisClient = null;
async function getRedis() {
  if (redisClient) return redisClient;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const { Redis } = require('@upstash/redis');
    redisClient = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  }
  return redisClient;
}

const WORLD_KEY = 'gothic-rpg:world';

async function loadState() {
  // Try Redis first
  const redis = await getRedis();
  if (redis) {
    try {
      const s = await redis.get(WORLD_KEY);
      if (s) return s;
    } catch (e) { console.error('Redis load error:', e.message); }
  }
  // Fall back to local file
  try {
    if (fs.existsSync(SAVE_FILE)) return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
  } catch (e) { console.error('File load error:', e.message); }
  return null;
}

async function saveState(state) {
  const clean = serializeWorld(state);
  // Redis
  const redis = await getRedis();
  if (redis) {
    try { await redis.set(WORLD_KEY, clean); } catch (e) { console.error('Redis save error:', e.message); }
  }
  // Local file
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(clean, null, 2), 'utf8'); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  Simulation constants
// ─────────────────────────────────────────────────────────────────────────────
const HERO_COLORS  = ['#7060d0','#d060a0','#60a0d0','#d0a060','#60d090'];
const HERO_NAMES   = ['Aldric','Mira','Corvus','Seraphel','Draven','Lirien','Varoth','Elyndra'];
const HERO_TITLES  = ['the Bold','the Cursed','Darkheart','Ironsoul','Ashborne'];
const ENEMY_NAMES  = ['Skeleton','Ghoul','Spider','Shade','Golem','Spectre','Troll'];
const HERO_IMAGES  = ['hero-red.png','hero-blue.png','hero-green.png','hero-purple.png'];
const ENEMY_STATS  = {
  Skeleton: { hp:[22,34],  atk:[2,3], xp:[4,7],   tier:1 },
  Spider:   { hp:[26,38],  atk:[2,4], xp:[6,9],   tier:1 },
  Ghoul:    { hp:[34,50],  atk:[3,5], xp:[8,12],  tier:2 },
  Shade:    { hp:[38,56],  atk:[3,5], xp:[10,14], tier:2 },
  Spectre:  { hp:[48,68],  atk:[4,6], xp:[13,17], tier:3 },
  Golem:    { hp:[60,86],  atk:[5,7], xp:[16,22], tier:3 },
  Troll:    { hp:[80,110], atk:[6,9], xp:[20,28], tier:4 },
};
const LOOT_NAMES   = ['Tome','Blade','Relic','Crystal','Potion','Amulet','Shield'];
const STEP_MS      = 120;
const SAVE_INTERVAL_TICKS = 300;
const BROADCAST_INTERVAL_TICKS = 10;

// ─────────────────────────────────────────────────────────────────────────────
//  World state
// ─────────────────────────────────────────────────────────────────────────────
let W = {
  tick:0, year:1,
  totalKills:0, totalDeaths:0, totalLoot:0, totalBattles:0,
  heroes:[], enemies:[], log:[]
};
let simSpeed  = 2;
let simPaused = false;
// Combat events to broadcast: [{heroName, type:'hero-hit'|'enemy-hit'}]
let pendingCombatEvents = [];

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function rng(n)  { return Math.floor(Math.random() * n); }
function rngf()  { return Math.random(); }
function pick(a) { return a[rng(a.length)]; }
function firstName(h) { return h.name.split(' ')[0]; }

function era() {
  return W.year < 10 ? 'Age of Shadow'
       : W.year < 25 ? 'Age of Blood'
       : W.year < 50 ? 'Age of Ash'
       :                'Age of Ruin';
}

function defaultState() {
  return { tick:0, year:1, totalKills:0, totalDeaths:0, totalLoot:0, totalBattles:0, heroes:[], enemies:[], log:[], savedAt:null };
}

// Strip circular refs for serialization
function serializeWorld(w) {
  return {
    tick: w.tick, year: w.year,
    totalKills: w.totalKills, totalDeaths: w.totalDeaths,
    totalLoot: w.totalLoot, totalBattles: w.totalBattles,
    heroes: w.heroes.map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk,
      xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
      color:h.color, state: h.state === 'hunt' ? 'explore' : h.state,
      stateTimer:h.stateTimer, isBlonde:h.isBlonde, fleeCount:h.fleeCount, image:h.image,
      targetName: h.target ? h.target.name : null
    })),
    enemies: w.enemies.map(e => ({
      id:e.id, name:e.name, hp:e.hp, maxhp:e.maxhp, atk:e.atk,
      xpReward:e.xpReward, tier:e.tier, state:e.state,
      engagedByName: e.engagedBy ? e.engagedBy.name : null
    })),
    log: w.log.slice(0, 40),
    savedAt: new Date().toISOString()
  };
}

// Full world snapshot to send to clients (includes live target data for arena)
function liveSnapshot() {
  return {
    tick: W.tick, year: W.year, era: era(),
    totalKills: W.totalKills, totalDeaths: W.totalDeaths,
    totalLoot: W.totalLoot, totalBattles: W.totalBattles,
    speed: simSpeed, paused: simPaused,
    heroes: W.heroes.map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk,
      xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
      color:h.color, state:h.state, stateTimer:h.stateTimer,
      isBlonde:h.isBlonde, fleeCount:h.fleeCount, image:h.image,
      target: h.target ? { name:h.target.name, hp:h.target.hp, maxhp:h.target.maxhp } : null
    })),
    enemies: W.enemies.map(e => ({
      id:e.id, name:e.name, hp:e.hp, maxhp:e.maxhp, atk:e.atk,
      xpReward:e.xpReward, tier:e.tier, state:e.state,
      engagedByName: e.engagedBy ? e.engagedBy.name : null
    })),
    log: W.log.slice(0, 40)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Spawn
// ─────────────────────────────────────────────────────────────────────────────
let enemyIdCounter = 1;

function spawnHero(forceBlonde) {
  const isBlonde = forceBlonde === true;
  const usedImages = new Set(W.heroes.map(h => h.image));
  const availImages = HERO_IMAGES.filter(i => !usedImages.has(i));
  const image = availImages.length ? pick(availImages) : pick(HERO_IMAGES);
  W.heroes.push({
    name:      isBlonde ? 'Kael the Stranger' : HERO_NAMES[rng(HERO_NAMES.length)] + ' ' + pick(HERO_TITLES),
    hp:        isBlonde ? 35 : 20 + rng(10),
    maxhp:     isBlonde ? 35 : 30,
    atk:       isBlonde ? 6  : 3 + rng(4),
    xp:0, level:1, loot:0, kills:0,
    color: isBlonde ? '#e8b830' : HERO_COLORS[rng(HERO_COLORS.length)],
    state:'explore', target:null, stateTimer:0,
    isBlonde, fleeCount:0, image
  });
}

function spawnEnemy() {
  const tierCap = Math.min(4, 1 + Math.floor(W.year / 6));
  const pool = ENEMY_NAMES.filter(n => ENEMY_STATS[n].tier <= tierCap);
  const name = pick(pool);
  const s = ENEMY_STATS[name];
  const hp = s.hp[0] + rng(s.hp[1] - s.hp[0] + 1);
  W.enemies.push({
    id: enemyIdCounter++,
    name, hp, maxhp:hp,
    atk: s.atk[0] + rng(s.atk[1] - s.atk[0] + 1),
    xpReward: s.xp[0] + rng(s.xp[1] - s.xp[0] + 1),
    tier: s.tier, state:'patrol', engagedBy:null
  });
}

function repopulate() {
  if (!W.heroes.some(h => h.isBlonde)) spawnHero(true);
  while (W.heroes.length < 4) spawnHero(false);
  while (W.enemies.length < 6 + Math.floor(W.year / 4)) spawnEnemy();
}

function addLog(msg, type) {
  W.log.unshift({ msg, type, t: W.year });
  if (W.log.length > 40) W.log.pop();
}

// ─────────────────────────────────────────────────────────────────────────────
//  Simulation tick
// ─────────────────────────────────────────────────────────────────────────────
function updateHero(h) {
  h.stateTimer--;
  if (h.state === 'explore') {
    if (h.stateTimer <= 0) h.stateTimer = 20 + rng(30);
    if (rngf() < 0.003) {
      h.loot++; W.totalLoot++; h.maxhp += 2;
      if (rngf() < 0.4) h.atk++;
      addLog(`${firstName(h)} found a ${pick(LOOT_NAMES)}!`, 'loot');
    }
    const target = W.enemies.find(e => e.hp > 0 && !e.engagedBy);
    if (target && rngf() < 0.06) {
      h.state = 'hunt'; h.target = target; target.engagedBy = h;
      h.stateTimer = 200 + rng(100);
    }
  } else if (h.state === 'hunt') {
    if (!h.target || h.target.hp <= 0 || h.stateTimer <= 0) {
      if (h.target) h.target.engagedBy = null;
      h.state = 'explore'; h.target = null; h.stateTimer = 20 + rng(20);
      return;
    }
    if (rngf() < 0.18) {
      const dmg = h.atk + rng(3);
      h.target.hp -= dmg;
      pendingCombatEvents.push({ heroName:h.name, type:'enemy-hit' });
      if (h.target.hp <= 0) {
        const tier = h.target.tier || 1;
        const suffix = tier >= 4 ? ' — a mighty victory!' : tier === 3 ? ' — a hard-won fight.' : '!';
        addLog(`${firstName(h)} slew ${h.target.name}${suffix}`, 'combat');
        h.xp += h.target.xpReward; h.kills++; W.totalKills++; W.totalBattles++;
        W.enemies = W.enemies.filter(e => e !== h.target);
        h.state = 'explore'; h.target = null; h.stateTimer = 15;
        if (h.xp >= h.level * 15) {
          h.level++; h.xp -= h.level * 15;
          h.maxhp += 5 + rng(5); h.hp = Math.min(h.hp + 10, h.maxhp); h.atk++;
          addLog(`${firstName(h)} reached Level ${h.level}!`, 'level');
        }
      }
    }
    if (h.target && rngf() < 0.14) {
      const dmg = h.target.atk + rng(2);
      h.hp -= dmg;
      pendingCombatEvents.push({ heroName:h.name, type:'hero-hit' });
      if (h.hp <= 0) {
        addLog(h.isBlonde ? 'Kael the Stranger has fallen!' : `${firstName(h)} fell to ${h.target.name}...`, 'death');
        W.totalDeaths++;
        if (h.target) h.target.engagedBy = null;
        W.heroes = W.heroes.filter(x => x !== h);
      } else if (h.hp < h.maxhp * 0.25 && !h.isBlonde) {
        h.fleeCount++;
        addLog(`${firstName(h)} flees from ${h.target.name}!`, 'explore');
        if (h.target) h.target.engagedBy = null;
        h.state = 'flee'; h.target = null; h.stateTimer = 20 + rng(15);
      }
    }
  } else if (h.state === 'flee') {
    h.hp = Math.min(h.hp + 1, h.maxhp);
    if (h.stateTimer <= 0) { h.state = 'explore'; h.stateTimer = 20; }
  }
}

function tick() {
  W.tick++;
  for (const h of [...W.heroes]) updateHero(h);
  if (W.tick % 80  === 0) repopulate();
  if (W.tick % 600 === 0) {
    W.year++;
    addLog(`Year ${W.year} begins. New threats stir in the dark.`, 'explore');
    for (let i = 0; i < 2; i++) spawnEnemy();
  }
  if (W.tick % SAVE_INTERVAL_TICKS === 0) saveState(W).catch(() => {});
  if (W.tick % BROADCAST_INTERVAL_TICKS === 0) {
    const snapshot = liveSnapshot();
    const events   = pendingCombatEvents.splice(0);
    broadcast({ type:'state', world: snapshot, combatEvents: events });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SSE broadcast
// ─────────────────────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send current snapshot immediately on connect
  res.write(`data: ${JSON.stringify({ type:'state', world: liveSnapshot(), combatEvents:[] })}\n\n`);

  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Control endpoints
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/speed', (req, res) => {
  const { speed } = req.body;
  if ([1,2,4].includes(speed)) { simSpeed = speed; simPaused = false; }
  broadcast({ type:'control', speed:simSpeed, paused:simPaused });
  res.json({ ok:true });
});

app.post('/api/pause', (req, res) => {
  simPaused = !simPaused;
  broadcast({ type:'control', speed:simSpeed, paused:simPaused });
  res.json({ ok:true, paused:simPaused });
});

app.post('/api/reset', async (req, res) => {
  // Clear Redis
  const redis = await getRedis();
  if (redis) { try { await redis.del(WORLD_KEY); } catch(e) {} }
  // Clear local file
  try { if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE); } catch(e) {}
  // Reset world
  W = { tick:0, year:1, totalKills:0, totalDeaths:0, totalLoot:0, totalBattles:0, heroes:[], enemies:[], log:[] };
  addLog('The world has been unmade. All begins anew.', 'explore');
  repopulate();
  broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] });
  res.json({ ok:true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Boot: load saved state, then start loop
// ─────────────────────────────────────────────────────────────────────────────
async function boot() {
  const saved = await loadState();
  if (saved && saved.tick !== undefined) {
    W.tick         = saved.tick         || 0;
    W.year         = saved.year         || 1;
    W.totalKills   = saved.totalKills   || 0;
    W.totalDeaths  = saved.totalDeaths  || 0;
    W.totalLoot    = saved.totalLoot    || 0;
    W.totalBattles = saved.totalBattles || 0;
    W.log          = saved.log          || [];
    // Restore heroes
    W.heroes = (saved.heroes || []).map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk,
      xp:h.xp||0, level:h.level||1, loot:h.loot||0, kills:h.kills||0,
      color:h.color||'#7060d0', state:'explore', target:null, stateTimer:0,
      isBlonde:h.isBlonde||false, fleeCount:h.fleeCount||0,
      image:h.image||HERO_IMAGES[0]
    }));
    // Restore enemies
    W.enemies = (saved.enemies || []).map(e => ({
      id: enemyIdCounter++,
      name:e.name, hp:e.hp, maxhp:e.maxhp, atk:e.atk,
      xpReward:e.xpReward||5, tier:e.tier||1,
      state:'patrol', engagedBy:null
    }));
    console.log(`World restored — Year ${W.year}, Tick ${W.tick}`);
  } else {
    console.log('New world starting...');
  }
  repopulate();

  app.listen(PORT, () => console.log(`Gothic RPG server running at http://localhost:${PORT}`));

  // Simulation loop
  let lastTick = Date.now();
  setInterval(() => {
    if (simPaused) return;
    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;
    const steps = Math.floor((elapsed * simSpeed) / STEP_MS);
    for (let i = 0; i < Math.min(steps, 20); i++) tick();
  }, STEP_MS);
}

boot().catch(console.error);
