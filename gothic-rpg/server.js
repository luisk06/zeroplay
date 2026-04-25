const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

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
let simSpeed  = 1;
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
      falls:h.falls||0, image:h.image,
      claimToken: h.claimToken || null,
      motto: h.motto || '',
      retired: h.retired || false, retiredAt: h.retiredAt || null,
      dailyViewSeconds: h.dailyViewSeconds || 0, dailyViewDay: h.dailyViewDay || null,
      presence: h.presence || 0,
      invokeUsedDay: h.invokeUsedDay || null,
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

// Single-hero live data for the hero page
function liveHero(h) {
  const tier = getPresenceTier(h.presence);
  return {
    name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk,
    xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
    color:h.color, state:h.state, isBlonde:h.isBlonde,
    fleeCount:h.fleeCount, falls:h.falls||0, image:h.image,
    motto: h.motto || '',
    hasClaim: !!h.claimToken,
    dailyViewSeconds: getDailyView(h),
    dailyViewGoal: DAILY_GOAL_SECONDS,
    presence: Math.round(h.presence || 0),
    presenceMax: PRESENCE_MAX,
    presenceTier: tier.name,
    presenceAtkMult: tier.atkMult,
    canInvoke: canInvoke(h),
    target: h.target ? { name:h.target.name, hp:h.target.hp, maxhp:h.target.maxhp } : null,
    log: W.log.filter(l => l.msg.startsWith(h.name.split(' ')[0])).slice(0, 12)
  };
}

function liveSnapshot() {
  return {
    tick:W.tick, year:W.year, era:era(),
    totalKills:W.totalKills, totalDeaths:W.totalDeaths, totalLoot:W.totalLoot, totalBattles:W.totalBattles,
    speed:simSpeed, paused:simPaused, viewers: clients.size,
    heroes: W.heroes.map(h => {
      const tier = getPresenceTier(h.presence);
      return {
        name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk,
        xp:h.xp, level:h.level, loot:h.loot, kills:h.kills,
        color:h.color, state:h.state, stateTimer:h.stateTimer,
        isBlonde:h.isBlonde, fleeCount:h.fleeCount, falls:h.falls||0, image:h.image,
        motto: h.motto || '', hasClaim: !!h.claimToken,
        dailyViewSeconds: getDailyView(h), dailyViewGoal: DAILY_GOAL_SECONDS,
        presence: Math.round(h.presence || 0),
        presenceMax: PRESENCE_MAX,
        presenceTier: tier.name,
        presenceAtkMult: tier.atkMult,
        target: h.target ? { name:h.target.name, hp:h.target.hp, maxhp:h.target.maxhp } : null
      };
    }),
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

  // Presence-based healing (explore / flee / exalted-in-combat)
  presenceHeal(h);

  if (h.state === 'wounded') {
    h.hp = Math.min(h.hp + 1, Math.floor(h.maxhp * 0.5));
    if (h.stateTimer <= 0) {
      h.state = 'explore';
      h.hp = Math.floor(h.maxhp * 0.5);
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
      // Presence ATK bonus + invoke crit
      let dmg = presenceAtk(h) + rng(3);
      let isCrit = false;
      if (h.invokePending) {
        dmg = dmg * 3;
        isCrit = true;
        h.invokePending = false;
        addLog(`${firstName(h)} channels the Presence — a crushing blow! (${dmg} dmg)`, 'level');
        pendingCombatEvents.push({ heroName:h.name, type:'invoke-crit' });
      }
      h.target.hp -= dmg;
      pendingCombatEvents.push({ heroName:h.name, type:'enemy-hit' });
      if (h.target.hp <= 0) {
        const tier = h.target.tier || 1;
        const suffix = tier >= 4 ? ' — a mighty victory!' : tier === 3 ? ' — a hard-won fight.' : '!';
        addLog(`${firstName(h)} slew ${h.target.name}${suffix}`, 'combat');
        const earnedXp = presenceXp(h, h.target.xpReward);
        h.xp += earnedXp; h.kills++; W.totalKills++; W.totalBattles++;
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
        defeatHero(h);
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

// ── Daily viewer tracking ─────────────────────────────────────────────────────
// Each hero accumulates dailyViewSeconds while their page has ≥1 viewer.
// Resets at UTC midnight. DAILY_GOAL_SECONDS = 300 (5 min).
const DAILY_GOAL_SECONDS = 300;

function utcDayStamp() { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }

// Called every second via setInterval for each hero that has active hero-page viewers
function tickHeroDailyView() {
  const today = utcDayStamp();
  for (const [heroName, set] of heroClients) {
    if (!set.size) continue;
    const hero = W.heroes.find(h => h.name === heroName);
    if (!hero) continue;
    // Reset on new day
    if (hero.dailyViewDay !== today) {
      hero.dailyViewDay     = today;
      hero.dailyViewSeconds = 0;
    }
    if (hero.dailyViewSeconds < DAILY_GOAL_SECONDS) {
      hero.dailyViewSeconds = (hero.dailyViewSeconds || 0) + 1;
    }
  }
}
setInterval(tickHeroDailyView, 1000);

function getDailyView(hero) {
  const today = utcDayStamp();
  if (hero.dailyViewDay !== today) return 0;
  return hero.dailyViewSeconds || 0;
}

// ── Presence system ───────────────────────────────────────────────────────────
// Presence builds while viewers watch a hero's page and decays when no one watches.
// It unlocks three tiers of stat bonuses (Noticed / Witnessed / Exalted).
//
// Accrual: presenceTick = viewers / (viewers + 2)  — diminishing returns
//   1 viewer  → +0.33/s     4 viewers → +0.67/s
//   2 viewers → +0.50/s    10 viewers → +0.83/s
//
// Decay: −0.2/s when no viewers (hero stays boosted a while after audience leaves)
// Cap: 100 points

const PRESENCE_MAX    = 100;
const PRESENCE_DECAY  = 0.2;   // per second when viewers = 0
const PRESENCE_TIERS  = [
  { min: 90, name: 'Exalted',   atkMult: 1.35, xpMult: 1.25, healRate: 1, healInCombat: true  },
  { min: 60, name: 'Witnessed', atkMult: 1.20, xpMult: 1.15, healRate: 1, healInCombat: false },
  { min: 30, name: 'Noticed',   atkMult: 1.10, xpMult: 1.10, healRate: 0, healInCombat: false },
  { min:  0, name: 'Unobserved',atkMult: 1.00, xpMult: 1.00, healRate: 0, healInCombat: false },
];

function getPresenceTier(presence) {
  for (const t of PRESENCE_TIERS) if ((presence || 0) >= t.min) return t;
  return PRESENCE_TIERS[PRESENCE_TIERS.length - 1];
}

// Called every second — ticks presence up or down based on live viewer count
function tickPresence() {
  for (const hero of W.heroes) {
    const viewers = heroViewerCount(hero.name);
    if (viewers > 0) {
      // Diminishing returns: each extra viewer adds less
      const delta = viewers / (viewers + 2);
      hero.presence = Math.min(PRESENCE_MAX, (hero.presence || 0) + delta);
    } else {
      hero.presence = Math.max(0, (hero.presence || 0) - PRESENCE_DECAY);
    }
  }
}
setInterval(tickPresence, 1000);

// Apply presence-based ATK bonus. Called in updateHero before damage calc.
function presenceAtk(hero) {
  const tier = getPresenceTier(hero.presence);
  return Math.round(hero.atk * tier.atkMult);
}

// Apply presence-based XP bonus. Called when XP is awarded.
function presenceXp(hero, baseXp) {
  const tier = getPresenceTier(hero.presence);
  return Math.round(baseXp * tier.xpMult);
}

// Presence-based out-of-combat healing (called each tick in updateHero)
function presenceHeal(hero) {
  const tier = getPresenceTier(hero.presence);
  if (!tier.healRate) return;
  if (hero.state === 'hunt' && !tier.healInCombat) return;
  if (hero.state === 'wounded') return; // wounded recovery handles its own HP
  hero.hp = Math.min(hero.maxhp, (hero.hp || 0) + tier.healRate);
}

// ── Invoke ability ────────────────────────────────────────────────────────────
// Owner can spend 40 Presence for a guaranteed 3× crit on the next hit.
// Tracked per-hero as `invokeReady` (bool) and `invokePending` (bool).
// Resets daily alongside dailyViewSeconds.
const INVOKE_COST = 40;

function canInvoke(hero) {
  return (hero.presence || 0) >= INVOKE_COST &&
         !hero.invokeUsedDay &&
         hero.state === 'hunt' &&
         !!hero.claimToken;
}

app.post('/api/hero/invoke', (req, res) => {
  const { heroName, claimToken } = req.body;
  const hero = findHeroBySlugOrName(heroName);
  if (!hero || !hero.claimToken) return res.status(404).json({ error: 'Hero not found' });
  if (hero.claimToken !== claimToken) return res.status(403).json({ error: 'Invalid token' });
  if (!canInvoke(hero)) return res.status(400).json({ error: 'Invoke not available' });
  hero.presence = Math.max(0, (hero.presence || 0) - INVOKE_COST);
  hero.invokePending = true;
  hero.invokeUsedDay = utcDayStamp();
  res.json({ ok: true, presence: hero.presence });
});

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
    const events = pendingCombatEvents.splice(0);
    // ── Optimization: serialize once, write the same string to all clients ──
    const worldMsg = `data: ${JSON.stringify({ type:'state', world: liveSnapshotWithViewers(), combatEvents: events })}\n\n`;
    for (const res of clients) {
      try { res.write(worldMsg); } catch (e) { clients.delete(res); }
    }
    // Per-hero SSE: each hero serialized once for all its viewers
    for (const [heroName, set] of heroClients) {
      if (!set.size) continue;
      const hero = W.heroes.find(h => h.name === heroName);
      const heroEvents = events.filter(e => e.heroName === heroName);
      const heroMsg = `data: ${JSON.stringify({ type:'hero', hero: hero ? liveHero(hero) : null, viewers: set.size, world:{ year:W.year, era:era() }, combatEvents: heroEvents })}\n\n`;
      for (const res of set) {
        try { res.write(heroMsg); } catch (e) { set.delete(res); }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SSE — viewer count + per-hero viewer tracking
// ─────────────────────────────────────────────────────────────────────────────
const clients = new Set();
// heroClients: Map<heroName, Set<res>>
const heroClients = new Map();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch (e) { clients.delete(res); }
  }
}

function broadcastHero(heroName, data) {
  const set = heroClients.get(heroName);
  if (!set) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(msg); } catch (e) { set.delete(res); }
  }
}

function heroViewerCount(heroName) {
  return (heroClients.get(heroName) || new Set()).size;
}

// Include per-hero viewer counts in the live snapshot
function liveSnapshotWithViewers() {
  const snap = liveSnapshot();
  snap.heroes = snap.heroes.map(h => ({
    ...h,
    heroViewers: heroViewerCount(h.name)
  }));
  return snap;
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  clients.add(res);
  res.write(`data: ${JSON.stringify({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] })}\n\n`);

  req.on('close', () => {
    clients.delete(res);
    broadcast({ type:'viewers', viewers: clients.size });
  });
});

// Hero-specific SSE stream — used by the hero detail page
app.get('/api/stream/hero', (req, res) => {
  const rawParam = req.query.name || '';
  const hero = findHeroBySlugOrName(rawParam);
  // Use the canonical hero name as the map key (always exact)
  const heroName = hero ? hero.name : decodeURIComponent(rawParam);
  if (!rawParam) return res.status(400).end();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  if (!heroClients.has(heroName)) heroClients.set(heroName, new Set());
  heroClients.get(heroName).add(res);

  // Send current state immediately
  res.write(`data: ${JSON.stringify({ type:'hero', hero: hero ? liveHero(hero) : null, viewers: heroViewerCount(heroName), world: { year:W.year, era:era() } })}\n\n`);

  // Broadcast updated viewer count to all hero-page viewers
  broadcastHero(heroName, { type:'viewers', viewers: heroViewerCount(heroName) });

  req.on('close', () => {
    const set = heroClients.get(heroName);
    if (set) { set.delete(res); if (set.size === 0) heroClients.delete(heroName); }
    broadcastHero(heroName, { type:'viewers', viewers: heroViewerCount(heroName) });
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
//  Join the World — add a new hero (viewer-initiated)
// ─────────────────────────────────────────────────────────────────────────────
// Simple rate-limit: max 1 new hero per 30s globally, and cap total heroes at 8
const JOIN_COOLDOWN_MS = 30000;
let lastJoinTime = 0;

app.post('/api/join', (req, res) => {
  const now = Date.now();
  if (now - lastJoinTime < JOIN_COOLDOWN_MS) {
    return res.status(429).json({ error: 'A hero just entered. Wait a moment before another joins.' });
  }
  if (W.heroes.length >= 8) {
    return res.status(400).json({ error: 'The world is full. Wait for a hero to fall before joining.' });
  }

  // Assign a unique name not already in use
  const usedNames = new Set(W.heroes.map(h => h.name));
  const availFirstNames = HERO_NAMES.filter(n => !W.heroes.some(h => h.name.startsWith(n)));
  const firstName = availFirstNames.length ? pick(availFirstNames) : pick(HERO_NAMES);
  const title     = pick(HERO_TITLES);
  const heroName  = `${firstName} ${title}`;

  // Assign unique image
  const usedImages  = new Set(W.heroes.map(h => h.image));
  const availImages = HERO_IMAGES.filter(i => !usedImages.has(i));
  const image       = availImages.length ? pick(availImages) : pick(HERO_IMAGES);

  const baseAtk = 3 + rng(4);
  const claimToken = crypto.randomUUID();
  const newHero = {
    name: heroName, hp: 20 + rng(10), maxhp: 30,
    atk: baseAtk, baseAtk,
    xp:0, level:1, loot:0, kills:0, falls:0,
    color: HERO_COLORS[rng(HERO_COLORS.length)],
    state:'explore', target:null, stateTimer: 20,
    isBlonde:false, fleeCount:0, image,
    claimToken,   // stored plaintext — this is a game, not credentials
    motto: '',
  };

  W.heroes.push(newHero);
  lastJoinTime = now;
  addLog(`${firstName} ${title} has joined the world!`, 'explore');
  broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] });
  // Return token ONCE — browser must store it
  res.json({ ok:true, heroName, claimToken });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Hero ownership endpoints (token-gated, no auth required)
// ─────────────────────────────────────────────────────────────────────────────

// Verify a claim token — returns hero name if valid
app.post('/api/hero/verify', (req, res) => {
  const { heroName, claimToken } = req.body;
  const hero = findHeroBySlugOrName(heroName);
  if (!hero || !hero.claimToken) return res.status(404).json({ error: 'Hero not found' });
  if (hero.claimToken !== claimToken) return res.status(403).json({ error: 'Invalid token' });
  res.json({ ok:true, heroName: hero.name, motto: hero.motto || '' });
});

// Set motto (owner only)
app.post('/api/hero/motto', (req, res) => {
  const { heroName, claimToken, motto } = req.body;
  const hero = findHeroBySlugOrName(heroName);
  if (!hero || !hero.claimToken) return res.status(404).json({ error: 'Hero not found' });
  if (hero.claimToken !== claimToken) return res.status(403).json({ error: 'Invalid token' });
  hero.motto = String(motto || '').slice(0, 80).trim();
  broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] });
  res.json({ ok:true, motto: hero.motto });
});

// Rename hero (owner only) — name must be unique, max 32 chars
app.post('/api/hero/rename', (req, res) => {
  const { heroName, claimToken, newName } = req.body;
  const hero = findHeroBySlugOrName(heroName);
  if (!hero || !hero.claimToken) return res.status(404).json({ error: 'Hero not found' });
  if (hero.claimToken !== claimToken) return res.status(403).json({ error: 'Invalid token' });

  const trimmed = String(newName || '').trim().slice(0, 32);
  if (!trimmed) return res.status(400).json({ error: 'Name cannot be empty' });
  if (trimmed === hero.name) return res.status(400).json({ error: 'That is already their name' });
  // Uniqueness check
  const taken = W.heroes.some(h => h !== hero && h.name.toLowerCase() === trimmed.toLowerCase());
  if (taken) return res.status(409).json({ error: 'A hero with that name already exists' });

  const oldName = hero.name;
  hero.name = trimmed;
  // Update the heroClients map key if present
  if (heroClients.has(oldName)) {
    const set = heroClients.get(oldName);
    heroClients.delete(oldName);
    heroClients.set(trimmed, set);
  }
  addLog(`${oldName} is now known as ${trimmed}.`, 'explore');
  broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] });
  res.json({ ok:true, heroName: trimmed, slug: slugify(trimmed) });
});

// Retire hero (owner only) — graceful exit, marks hero as retired
app.post('/api/hero/retire', (req, res) => {
  const { heroName, claimToken } = req.body;
  const hero = findHeroBySlugOrName(heroName);
  if (!hero || !hero.claimToken) return res.status(404).json({ error: 'Hero not found' });
  if (hero.claimToken !== claimToken) return res.status(403).json({ error: 'Invalid token' });
  hero.state    = 'retired';
  hero.retired  = true;
  hero.retiredAt = W.year;
  if (hero.target) { hero.target.engagedBy = null; hero.target = null; }
  addLog(`${hero.name} has chosen to leave the world. Their legend endures.`, 'death');
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

// Serve hero page (public)
app.get('/hero', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'hero.html'));
});

// Slug helpers — convert "Iron Wolf" ↔ "iron-wolf"
function slugify(name) { return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''); }
function findHeroBySlugOrName(nameParam) {
  if (!nameParam) return null;
  const decoded = decodeURIComponent(nameParam);
  // Exact match first
  let h = W.heroes.find(h => h.name === decoded);
  if (h) return h;
  // Slug match fallback
  const slug = decoded.toLowerCase().replace(/\s+/g,'-');
  return W.heroes.find(h => slugify(h.name) === slug) || null;
}

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
      isBlonde:h.isBlonde||false, fleeCount:h.fleeCount||0, image:h.image||HERO_IMAGES[0],
      claimToken: h.claimToken || null, motto: h.motto || '',
      retired: h.retired || false, retiredAt: h.retiredAt || null,
      dailyViewSeconds: h.dailyViewSeconds || 0, dailyViewDay: h.dailyViewDay || null,
      presence: h.presence || 0, invokeUsedDay: h.invokeUsedDay || null
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
