const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────────────────────
//  Persistence
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
  const redis = await getRedis();
  if (redis) {
    try { const s = await redis.get(WORLD_KEY); if (s) return s; } catch (e) { console.error('Redis load:', e.message); }
  }
  try { if (fs.existsSync(SAVE_FILE)) return JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch (e) {}
  return null;
}

async function saveState(w) {
  const clean = serializeWorld(w);
  const redis = await getRedis();
  if (redis) { try { await redis.set(WORLD_KEY, clean); } catch (e) { console.error('Redis save:', e.message); } }
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(clean, null, 2), 'utf8'); } catch (e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  Admin auth middleware
// ─────────────────────────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'gothic2025';

function requireAdmin(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const [type, encoded] = auth.split(' ');
  if (type === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="Gothic RPG Admin"');
  res.status(401).send('Unauthorized');
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
const SAVE_INTERVAL_TICKS     = 300;
const BROADCAST_INTERVAL_TICKS = 10;
// How long a wounded hero is out of action (in ticks)
const WOUNDED_RECOVERY_TICKS  = 300;

// ─────────────────────────────────────────────────────────────────────────────
//  World state
// ─────────────────────────────────────────────────────────────────────────────
let W = { tick:0, year:1, totalKills:0, totalDeaths:0, totalLoot:0, totalBattles:0, heroes:[], enemies:[], log:[] };
let simSpeed  = 2;
let simPaused = false;
let pendingCombatEvents = [];

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────
function rng(n)  { return Math.floor(Math.random() * n); }
function rngf()  { return Math.random(); }
function pick(a) { return a[rng(a.length)]; }
function firstName(h) { return h.name.split(' ')[0]; }
function era() {
  return W.year < 10 ? 'Age of Shadow' : W.year < 25 ? 'Age of Blood' : W.year < 50 ? 'Age of Ash' : 'Age of Ruin';
}

function serializeWorld(w) {
  return {
    tick:w.tick, year:w.year,
    totalKills:w.totalKills, totalDeaths:w.totalDeaths, totalLoot:w.totalLoot, totalBattles:w.totalBattles,
    heroes: w.heroes.map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk,
      xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
      color:h.color, state: (h.state === 'hunt' || h.state === 'wounded') ? h.state : 'explore',
      stateTimer:h.stateTimer, isBlonde:h.isBlonde, fleeCount:h.fleeCount,
      falls:h.falls||0, image:h.image
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

function liveSnapshot() {
  return {
    tick:W.tick, year:W.year, era:era(),
    totalKills:W.totalKills, totalDeaths:W.totalDeaths, totalLoot:W.totalLoot, totalBattles:W.totalBattles,
    speed:simSpeed, paused:simPaused, viewers: clients.size,
    heroes: W.heroes.map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk,
      xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
      color:h.color, state:h.state, stateTimer:h.stateTimer,
      isBlonde:h.isBlonde, fleeCount:h.fleeCount, falls:h.falls||0, image:h.image,
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
  const baseAtk = isBlonde ? 6 : 3 + rng(4);
  W.heroes.push({
    name:      isBlonde ? 'Kael the Stranger' : HERO_NAMES[rng(HERO_NAMES.length)] + ' ' + pick(HERO_TITLES),
    hp:        isBlonde ? 35 : 20 + rng(10),
    maxhp:     isBlonde ? 35 : 30,
    atk: baseAtk, baseAtk,
    xp:0, level:1, loot:0, kills:0, falls:0,
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
//  Hero defeat consequences (no permadeath)
// ─────────────────────────────────────────────────────────────────────────────
function defeatHero(h) {
  W.totalDeaths++;
  h.falls = (h.falls || 0) + 1;

  // Disengage from enemy
  if (h.target) { h.target.engagedBy = null; h.target = null; }

  // XP penalty — lose 30%, can't go below 0
  const xpLost = Math.floor(h.xp * 0.30);
  h.xp = Math.max(0, h.xp - xpLost);

  // ATK penalty — lose 1 point per fall, floored at baseAtk
  if (h.atk > (h.baseAtk || 1)) h.atk--;

  // HP reset to 25%
  h.hp = Math.max(1, Math.floor(h.maxhp * 0.25));

  // Enter wounded state
  h.state = 'wounded';
  h.stateTimer = WOUNDED_RECOVERY_TICKS + rng(100);

  const penalty = xpLost > 0 ? ` Lost ${xpLost} XP.` : '';
  if (h.isBlonde) {
    addLog(`Kael the Stranger has fallen and lies wounded!${penalty}`, 'death');
  } else {
    addLog(`${firstName(h)} was defeated and crawls away to recover.${penalty}`, 'death');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Simulation tick
// ─────────────────────────────────────────────────────────────────────────────
function updateHero(h) {
  h.stateTimer--;

  if (h.state === 'wounded') {
    // Slowly recover HP while wounded
    h.hp = Math.min(h.hp + 1, Math.floor(h.maxhp * 0.5));
    if (h.stateTimer <= 0) {
      h.state = 'explore';
      h.hp = Math.floor(h.maxhp * 0.5); // return at half HP
      h.stateTimer = 20 + rng(20);
      addLog(`${firstName(h)} returns to the field, scarred but resolute.`, 'explore');
    }
    return;
  }

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
        defeatHero(h); // <-- defeat with consequences, no removal
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
    broadcast({ type:'state', world: liveSnapshot(), combatEvents: pendingCombatEvents.splice(0) });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SSE — viewer count included in every broadcast
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

  clients.add(res);
  // Send snapshot immediately — clients.size now includes this client
  res.write(`data: ${JSON.stringify({ type:'state', world: liveSnapshot(), combatEvents:[] })}\n\n`);

  req.on('close', () => {
    clients.delete(res);
    // Broadcast updated viewer count
    broadcast({ type:'viewers', viewers: clients.size });
  });
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
  const redis = await getRedis();
  if (redis) { try { await redis.del(WORLD_KEY); } catch(e) {} }
  try { if (fs.existsSync(SAVE_FILE)) fs.unlinkSync(SAVE_FILE); } catch(e) {}
  W = { tick:0, year:1, totalKills:0, totalDeaths:0, totalLoot:0, totalBattles:0, heroes:[], enemies:[], log:[] };
  addLog('The world has been unmade. All begins anew.', 'explore');
  repopulate();
  broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] });
  res.json({ ok:true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Admin endpoints (protected)
// ─────────────────────────────────────────────────────────────────────────────
// Serve admin page
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get full hero list for admin
app.get('/api/admin/heroes', requireAdmin, (req, res) => {
  res.json(W.heroes.map(h => ({
    name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk,
    xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
    state:h.state, falls:h.falls||0, isBlonde:h.isBlonde, image:h.image,
    fleeCount:h.fleeCount
  })));
});

// Update a specific hero's fields
app.post('/api/admin/hero', requireAdmin, (req, res) => {
  const { name, hp, maxhp, atk, xp, level, kills, loot, state } = req.body;
  const hero = W.heroes.find(h => h.name === name);
  if (!hero) return res.status(404).json({ error: 'Hero not found' });

  if (hp    !== undefined) hero.hp    = Math.max(0, parseInt(hp));
  if (maxhp !== undefined) hero.maxhp = Math.max(1, parseInt(maxhp));
  if (atk   !== undefined) { hero.atk = Math.max(1, parseInt(atk)); hero.baseAtk = hero.baseAtk || hero.atk; }
  if (xp    !== undefined) hero.xp    = Math.max(0, parseInt(xp));
  if (level !== undefined) hero.level = Math.max(1, parseInt(level));
  if (kills !== undefined) hero.kills = Math.max(0, parseInt(kills));
  if (loot  !== undefined) hero.loot  = Math.max(0, parseInt(loot));
  if (state && ['explore','wounded','flee'].includes(state)) {
    if (hero.target) { hero.target.engagedBy = null; hero.target = null; }
    hero.state = state;
    hero.stateTimer = 30;
  }

  addLog(`[ADMIN] ${name} stats modified.`, 'explore');
  broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] });
  res.json({ ok:true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────────────────────
async function boot() {
  const saved = await loadState();
  if (saved && saved.tick !== undefined) {
    W.tick = saved.tick || 0; W.year = saved.year || 1;
    W.totalKills = saved.totalKills || 0; W.totalDeaths = saved.totalDeaths || 0;
    W.totalLoot = saved.totalLoot || 0; W.totalBattles = saved.totalBattles || 0;
    W.log = saved.log || [];
    W.heroes = (saved.heroes || []).map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk||h.atk,
      xp:h.xp||0, level:h.level||1, loot:h.loot||0, kills:h.kills||0, falls:h.falls||0,
      color:h.color||'#7060d0', state: h.state === 'wounded' ? 'wounded' : 'explore',
      target:null, stateTimer: h.state === 'wounded' ? (h.stateTimer||WOUNDED_RECOVERY_TICKS) : 0,
      isBlonde:h.isBlonde||false, fleeCount:h.fleeCount||0, image:h.image||HERO_IMAGES[0]
    }));
    W.enemies = (saved.enemies || []).map(e => ({
      id:enemyIdCounter++, name:e.name, hp:e.hp, maxhp:e.maxhp, atk:e.atk,
      xpReward:e.xpReward||5, tier:e.tier||1, state:'patrol', engagedBy:null
    }));
    console.log(`World restored — Year ${W.year}, Tick ${W.tick}`);
  } else {
    console.log('New world starting...');
  }
  repopulate();

  app.listen(PORT, () => console.log(`Gothic RPG server at http://localhost:${PORT}`));

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
