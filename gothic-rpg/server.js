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

// ── Hero Personality Traits ───────────────────────────────────────────────────
// Each hero gets 2 traits at spawn that permanently colour their behaviour.
const TRAITS = {
  reckless:   { label:'Reckless',   engage: +0.03,  flee: -0.08,  loot: 0,     xp: 0,    log: ['charges forward heedlessly','hurls themselves at the foe'] },
  cautious:   { label:'Cautious',   engage: -0.02,  flee: +0.06,  loot: 0,     xp: 0,    log: ['watches from the shadows first','edges forward warily'] },
  greedy:     { label:'Greedy',     engage: 0,      flee: 0,      loot:+0.003, xp: 0,    log: ['rummages through the ruins','pockets everything in reach'] },
  bloodthirsty:{ label:'Bloodthirsty', engage:+0.02, flee:-0.05, loot: 0,    xp:+0.10, log: ['thirsts for another kill','fights with savage relish'] },
  cowardly:   { label:'Cowardly',   engage: -0.03,  flee: +0.10,  loot: 0,     xp:-0.05, log: ['flinches at the sight of the enemy','hesitates at the threshold'] },
  tenacious:  { label:'Tenacious',  engage: +0.01,  flee: -0.06,  loot: 0,     xp:+0.05, log: ['refuses to yield','grits their teeth and presses on'] },
  scholarly:  { label:'Scholarly',  engage: 0,      flee: 0,      loot:+0.002, xp:+0.15, log: ['studies the creature\'s weaknesses','recites the old battle-lore'] },
  cursed:     { label:'Cursed',     engage: +0.02,  flee: 0,      loot:-0.001, xp: 0,    log: ['is drawn toward danger by some dark compulsion','moves as if guided by an unseen hand'] },
};
const TRAIT_KEYS = Object.keys(TRAITS);

function pickTraits() {
  const shuffled = TRAIT_KEYS.slice().sort(() => rngf() - 0.5);
  return shuffled.slice(0, 2);
}

function traitEngageMod(h)  { return (h.traits || []).reduce((s, k) => s + (TRAITS[k]?.engage || 0), 0); }
function traitFleeMod(h)    { return (h.traits || []).reduce((s, k) => s + (TRAITS[k]?.flee   || 0), 0); }
function traitLootMod(h)    { return (h.traits || []).reduce((s, k) => s + (TRAITS[k]?.loot   || 0), 0); }
function traitXpMult(h)     { return 1 + (h.traits || []).reduce((s, k) => s + (TRAITS[k]?.xp || 0), 0); }
function traitLog(h)        { const logs = (h.traits || []).flatMap(k => TRAITS[k]?.log || []); return logs.length ? pick(logs) : null; }

// ── Hero Emotional State ──────────────────────────────────────────────────────
const MOODS = {
  resolute:   { label:'Resolute',   emoji:'⚔', desc:'Steady and unshaken.' },
  haunted:    { label:'Haunted',    emoji:'👁', desc:'Dark memories linger.' },
  vengeful:   { label:'Vengeful',   emoji:'🔥', desc:'Burning for retribution.' },
  weary:      { label:'Weary',      emoji:'💤', desc:'The road has taken its toll.' },
  triumphant: { label:'Triumphant', emoji:'✨', desc:'Riding high on victory.' },
};
const MOOD_KEYS = Object.keys(MOODS);

function setMood(h, mood) {
  h.mood = mood;
  h.moodText = MOODS[mood]?.desc || '';
}

// ── Mortality Clock ───────────────────────────────────────────────────────────
// Heroes gain an "age" in world-years. Old heroes become legendary and stoic.
// Heroes over age 20 recover more slowly but gain bonus XP from every kill.
const HERO_AGE_THRESHOLD = 15;   // years before old-age flavour kicks in

// ── Storm/Quiet system ────────────────────────────────────────────────────────
// The world oscillates between calm and storm. During a storm:
//   • Enemy engagement chance doubles
//   • Loot find chance +50%
//   • Wounded recovery ticks reduced by 25%
//   • Atmospheric log entries fire at start/end
//   • Frontend era bar pulses red; feed background dims
//
// Storm length:  150–400 ticks (~18s–48s at 1× speed)
// Calm length:   300–700 ticks (~36s–84s)
// First storm fires after an initial calm period of 400–600 ticks.

const STORM_ENGAGE_MULT  = 2.0;
const STORM_LOOT_MULT    = 1.5;
const STORM_RECOVERY_CUT = 0.75;   // recovery ticks multiplied by this during storm

const STORM_START_MSGS = [
  'The sky tears open — darkness floods the realm.',
  'A fell wind rises. The air tastes of blood.',
  'Something ancient stirs. The world shudders.',
  'Thunder without lightning. The beasts grow bold.',
  'The shadows deepen. Danger is everywhere.',
];
const STORM_END_MSGS = [
  'The storm breaks. An eerie calm settles.',
  'Silence. The darkness retreats — for now.',
  'The air clears. The wounded begin to breathe.',
  'Stillness returns, thick with the smell of ash.',
  'The tempest fades. Survivors count their dead.',
];

// ── Cross-Hero Encounters ─────────────────────────────────────────────────────
// When two exploring heroes are in proximity, they may cross paths.
// Encounter frequency: checked every ENCOUNTER_CHECK_TICKS ticks per pair.
// Pair history tracked in W.heroEncounters (key: "A|B" sorted).
// Tone escalates: 0 meetings = neutral, 1–2 = familiar, 3+ = legendary.

const ENCOUNTER_CHECK_TICKS = 200;
const ENCOUNTER_BASE_CHANCE = 0.015;   // per pair per check

const ENCOUNTER_LINES = {
  neutral: [
    (a, b) => `${firstName(a)} and ${firstName(b)} cross paths in the dark — a silent nod, then apart.`,
    (a, b) => `${firstName(a)} glimpses ${firstName(b)} across the ruins. Neither speaks.`,
    (a, b) => `${firstName(b)} passes ${firstName(a)} without a word. Two fates, briefly aligned.`,
  ],
  familiar: [
    (a, b) => `${firstName(a)} and ${firstName(b)} share a moment of grim recognition.`,
    (a, b) => `"Still alive," ${firstName(a)} mutters. ${firstName(b)} almost smiles.`,
    (a, b) => `${firstName(b)} stops. "${firstName(a)}." A name said like a scar.`,
  ],
  legendary: [
    (a, b) => `${firstName(a)} and ${firstName(b)} meet again — old survivors in a dying world.`,
    (a, b) => `The veterans ${firstName(a)} and ${firstName(b)} cross paths once more. The world remembers.`,
    (a, b) => `${firstName(b)} and ${firstName(a)}: two names already whispered as legend.`,
  ],
};

// Mood-flavoured encounter overlays — appended when moods match interesting combos
function encounterMoodFlavour(a, b) {
  if (a.mood === 'vengeful' && b.mood === 'vengeful') return ' Both burn with the same cold fury.';
  if (a.mood === 'haunted'  || b.mood === 'haunted')  return ' Something unsaid hangs between them.';
  if (a.mood === 'triumphant' && b.mood === 'weary')  return ` ${firstName(b)} looks at ${firstName(a)}'s pride with hollow eyes.`;
  if (a.mood === 'triumphant' && b.mood === 'triumphant') return ' Two victors. The world cannot hold both.';
  return '';
}

function encounterKey(a, b) {
  return [a.name, b.name].sort().join('|');
}

// ─────────────────────────────────────────────────────────────────────────────
//  World state
// ─────────────────────────────────────────────────────────────────────────────
let W = {
  tick:0, year:1, totalKills:0, totalDeaths:0, totalLoot:0, totalBattles:0,
  heroes:[], enemies:[], log:[], worldFirsts:{},
  stormActive: false, stormTimer: 0,
  heroEncounters: {},   // key → count
};
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
      traits: h.traits || [],
      mood: h.mood || 'resolute', moodText: h.moodText || '',
      bornYear: h.bornYear || 1,
      isMock: h.isMock || false,
    })),
    enemies: w.enemies.map(e => ({
      id:e.id, name:e.name, hp:e.hp, maxhp:e.maxhp, atk:e.atk,
      xpReward:e.xpReward, tier:e.tier, state:e.state,
      engagedByName: e.engagedBy ? e.engagedBy.name : null
    })),
    log: w.log.slice(0, 40),
    worldFirsts: w.worldFirsts || {},
    stormActive: w.stormActive || false,
    stormTimer:  w.stormTimer  || 0,
    heroEncounters: w.heroEncounters || {},
    savedAt: new Date().toISOString()
  };
}

// Single-hero live data for the hero page
function heroAge(h) { return Math.max(0, W.year - (h.bornYear || 1)); }

function liveHero(h) {
  const tier = getPresenceTier(h.presence);
  const age = heroAge(h);
  const traitLabels = (h.traits || []).map(k => ({ key: k, label: TRAITS[k]?.label || k }));
  const moodObj = MOODS[h.mood] || MOODS.resolute;
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
    log: W.log.filter(l => l.msg.startsWith(h.name.split(' ')[0])).slice(0, 12),
    traits: traitLabels,
    mood: h.mood || 'resolute',
    moodLabel: moodObj.label,
    moodEmoji: moodObj.emoji,
    moodDesc: moodObj.desc,
    bornYear: h.bornYear || 1,
    heroAge: age,
    isAged: age >= HERO_AGE_THRESHOLD,
    isMock: h.isMock || false,
  };
}

function liveSnapshot() {
  return {
    tick:W.tick, year:W.year, era:era(),
    totalKills:W.totalKills, totalDeaths:W.totalDeaths, totalLoot:W.totalLoot, totalBattles:W.totalBattles,
    speed:simSpeed, paused:simPaused, viewers: clients.size,
    worldFirsts: W.worldFirsts || {},
    stormActive: W.stormActive || false,
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
        target: h.target ? { name:h.target.name, hp:h.target.hp, maxhp:h.target.maxhp } : null,
        traits: (h.traits || []).map(k => ({ key: k, label: TRAITS[k]?.label || k })),
        mood: h.mood || 'resolute',
        moodLabel: (MOODS[h.mood] || MOODS.resolute).label,
        moodEmoji: (MOODS[h.mood] || MOODS.resolute).emoji,
        heroAge: heroAge(h),
        isAged: heroAge(h) >= HERO_AGE_THRESHOLD,
        dramaScore: dramascoreOf(h),
        isMock: h.isMock || false
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
  const traits = isBlonde ? ['tenacious','reckless'] : pickTraits();
  W.heroes.push({
    name:      isBlonde ? 'Kael the Stranger' : HERO_NAMES[rng(HERO_NAMES.length)] + ' ' + pick(HERO_TITLES),
    hp:        isBlonde ? 35 : 20 + rng(10),
    maxhp:     isBlonde ? 35 : 30,
    atk: baseAtk, baseAtk,
    xp:0, level:1, loot:0, kills:0, falls:0,
    color: isBlonde ? '#e8b830' : HERO_COLORS[rng(HERO_COLORS.length)],
    state:'explore', target:null, stateTimer:0,
    isBlonde, fleeCount:0, image,
    traits,
    mood: 'resolute', moodText: MOODS.resolute.desc,
    bornYear: W.year || 1,
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

  // Mood transitions on defeat
  if (h.falls >= 3) setMood(h, 'haunted');
  else if (h.kills >= 5) setMood(h, 'vengeful');
  else setMood(h, 'weary');
  checkMilestones(h);

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
    // During storm, wounded heroes are forced back faster (urgency)
    const recoveryTick = W.stormActive ? 2 : 1;
    h.hp = Math.min(h.hp + recoveryTick, Math.floor(h.maxhp * 0.5));
    h.stateTimer -= W.stormActive ? 1 : 0;   // extra tick burn during storm
    if (h.stateTimer <= 0) {
      h.state = 'explore';
      h.hp = Math.floor(h.maxhp * 0.5);
      h.stateTimer = 20 + rng(20);
      // Mood on recovery
      if (h.mood === 'haunted' || h.mood === 'weary') setMood(h, 'resolute');
      const stormReturn = W.stormActive ? ' The storm drove them back to the fight.' : '';
      addLog(`${firstName(h)} returns to the field, scarred but resolute.${stormReturn}`, 'explore');
    }
    return;
  }

  if (h.state === 'explore') {
    if (h.stateTimer <= 0) h.stateTimer = 20 + rng(30);
    const stormMult   = W.stormActive ? STORM_LOOT_MULT : 1;
    const lootChance  = (0.003 + traitLootMod(h)) * stormMult;
    if (rngf() < lootChance) {
      h.loot++; W.totalLoot++; h.maxhp += 2;
      if (rngf() < 0.4) h.atk++;
      const tl = traitLog(h);
      addLog(`${firstName(h)} found a ${pick(LOOT_NAMES)}! ${tl ? `(${tl})` : ''}`.trim(), 'loot');
    }
    const target = W.enemies.find(e => e.hp > 0 && !e.engagedBy);
    const stormEngageMult = W.stormActive ? STORM_ENGAGE_MULT : 1;
    const engageChance = (0.06 + traitEngageMod(h)) * stormEngageMult;
    if (target && rngf() < engageChance) {
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
        const tl = traitLog(h);
        addLog(`${firstName(h)} slew ${h.target.name}${suffix}${tl ? ` ${tl}.` : ''}`, 'combat');
        const baseXp = h.target.xpReward;
        // Aged hero bonus XP
        const ageBonus = heroAge(h) >= HERO_AGE_THRESHOLD ? 1.15 : 1;
        const earnedXp = Math.round(presenceXp(h, baseXp) * traitXpMult(h) * ageBonus);
        h.xp += earnedXp; h.kills++; W.totalKills++; W.totalBattles++;
        W.enemies = W.enemies.filter(e => e !== h.target);
        h.state = 'explore'; h.target = null; h.stateTimer = 15;
        // Mood: triumphant on kill
        if (h.mood !== 'vengeful') setMood(h, 'triumphant');
        // Milestone check after stats update
        checkMilestones(h);
        if (h.xp >= h.level * 15) {
          h.level++; h.xp -= h.level * 15;
          h.maxhp += 5 + rng(5); h.hp = Math.min(h.hp + 10, h.maxhp); h.atk++;
          addLog(`${firstName(h)} reached Level ${h.level}!`, 'level');
          checkMilestones(h);
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
        const fleeRoll = rngf();
        const fleeMod = traitFleeMod(h);
        // Reckless heroes rarely flee even when hurt; cowardly flee more
        if (fleeRoll < 0.6 + fleeMod) {
          h.fleeCount++;
          addLog(`${firstName(h)} flees from ${h.target.name}!`, 'explore');
          if (h.target) h.target.engagedBy = null;
          h.state = 'flee'; h.target = null; h.stateTimer = 20 + rng(15);
        }
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
    const prevPresence = hero.presence || 0;
    if (viewers > 0) {
      // Diminishing returns: each extra viewer adds less
      const delta = viewers / (viewers + 2);
      hero.presence = Math.min(PRESENCE_MAX, prevPresence + delta);
    } else {
      hero.presence = Math.max(0, prevPresence - PRESENCE_DECAY);
    }
    // Check Exalted milestone when crossing 90
    if (prevPresence < 90 && hero.presence >= 90) checkMilestones(hero);
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

// ── Milestone system ──────────────────────────────────────────────────────────
// Tracks world-first achievements. Each fires once, emits a 'milestone' SSE
// event that the client renders as a full-width banner.
const MILESTONE_DEFS = [
  { key:'first_level5',   check: h => h.level >= 5,   msg: h => `${h.name} becomes the first to reach Veteran rank!` },
  { key:'first_level8',   check: h => h.level >= 8,   msg: h => `${h.name} ascends to Champion — the first of this age!` },
  { key:'first_level12',  check: h => h.level >= 12,  msg: h => `${h.name} rises to Warlord — an unprecedented feat!` },
  { key:'first_kills10',  check: h => h.kills >= 10,  msg: h => `${h.name} has slain 10 foes — the first blood-tithe fulfilled!` },
  { key:'first_kills50',  check: h => h.kills >= 50,  msg: h => `${h.name} reaches 50 kills — a legend is born!` },
  { key:'first_falls5',   check: h => (h.falls||0) >= 5, msg: h => `${h.name} has fallen 5 times and risen again — truly unkillable.` },
  { key:'first_exalted',  check: h => (h.presence||0) >= 90, msg: h => `${h.name} ascends to Exalted Presence — the crowd erupts!` },
];

function checkMilestones(h) {
  for (const def of MILESTONE_DEFS) {
    if (W.worldFirsts[def.key]) continue;          // already claimed
    if (!def.check(h)) continue;
    W.worldFirsts[def.key] = { heroName: h.name, year: W.year, tick: W.tick };
    const msg = def.msg(h);
    addLog(`✸ MILESTONE: ${msg}`, 'level');
    // Broadcast milestone event to all viewers
    const milestoneMsg = `data: ${JSON.stringify({ type:'milestone', key: def.key, heroName: h.name, message: msg, year: W.year })}\n\n`;
    for (const res of clients) {
      try { res.write(milestoneMsg); } catch(e) { clients.delete(res); }
    }
  }
}

// ── Drama score ───────────────────────────────────────────────────────────────
// Computed per-hero at broadcast time. Used by the client to spotlight the most
// narratively compelling hero for first-time visitors.
// Score = (kills×2) + (level×3) + (falls×4) + (presence/10) + combatBonus + viewerBonus
function dramascoreOf(h) {
  const combatBonus  = h.state === 'hunt' ? 15 : 0;
  const woundedBonus = h.state === 'wounded' ? 8 : 0;
  const viewerBonus  = heroViewerCount(h.name) * 5;
  const moodBonus    = h.mood === 'vengeful' ? 10 : h.mood === 'haunted' ? 7 : 0;
  const ageBonus     = heroAge(h) >= HERO_AGE_THRESHOLD ? 6 : 0;
  return (h.kills * 2) + (h.level * 3) + ((h.falls||0) * 4) +
         Math.round((h.presence||0) / 10) + combatBonus + woundedBonus +
         viewerBonus + moodBonus + ageBonus;
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

// ── Storm tick ────────────────────────────────────────────────────────────────
function tickStorm() {
  W.stormTimer--;
  if (W.stormTimer > 0) return;

  if (W.stormActive) {
    // Storm ends → calm
    W.stormActive = false;
    W.stormTimer  = 300 + rng(400);   // calm: 300–700 ticks
    addLog(pick(STORM_END_MSGS), 'explore');
    // Broadcast storm-end event
    const msg = `data: ${JSON.stringify({ type:'storm', active: false })}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch(e) { clients.delete(res); } }
  } else {
    // Calm ends → storm
    W.stormActive = true;
    W.stormTimer  = 150 + rng(250);   // storm: 150–400 ticks
    addLog(pick(STORM_START_MSGS), 'death');
    const msg = `data: ${JSON.stringify({ type:'storm', active: true })}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch(e) { clients.delete(res); } }
  }
}

// ── Encounter tick ────────────────────────────────────────────────────────────
function tickEncounters() {
  const exploring = W.heroes.filter(h => h.state === 'explore' && !h.retired);
  if (exploring.length < 2) return;

  for (let i = 0; i < exploring.length; i++) {
    for (let j = i + 1; j < exploring.length; j++) {
      const a = exploring[i];
      const b = exploring[j];
      if (rngf() >= ENCOUNTER_BASE_CHANCE) continue;

      const key   = encounterKey(a, b);
      const count = W.heroEncounters[key] || 0;
      W.heroEncounters[key] = count + 1;

      const tone  = count === 0 ? 'neutral' : count <= 2 ? 'familiar' : 'legendary';
      const lines = ENCOUNTER_LINES[tone];
      let msg     = pick(lines)(a, b) + encounterMoodFlavour(a, b);

      // Trait colour — if one is reckless and the other cautious, note the contrast
      const aTraits = a.traits || [];
      const bTraits = b.traits || [];
      if (aTraits.includes('reckless') && bTraits.includes('cautious')) {
        msg += ` ${firstName(a)} itches to move. ${firstName(b)} holds still.`;
      } else if (aTraits.includes('bloodthirsty') || bTraits.includes('bloodthirsty')) {
        msg += count >= 3 ? ' The air between them thickens.' : '';
      }

      addLog(msg, 'explore');

      // Fire encounter SSE event to both heroes' page viewers
      const encounterEvt = { type:'encounter', heroNames:[a.name, b.name], tone, count: count + 1 };
      for (const heroName of [a.name, b.name]) {
        const set = heroClients.get(heroName);
        if (!set || !set.size) continue;
        const evtMsg = `data: ${JSON.stringify({ type:'hero-event', event: encounterEvt })}\n\n`;
        for (const res of set) { try { res.write(evtMsg); } catch(e) { set.delete(res); } }
      }
    }
  }
}

function tick() {
  W.tick++;
  tickStorm();
  for (const h of [...W.heroes]) updateHero(h);
  if (W.tick % ENCOUNTER_CHECK_TICKS === 0) tickEncounters();
  if (W.tick % 80  === 0) repopulate();
  if (W.tick % 600 === 0) {
    W.year++;
    addLog(`Year ${W.year} begins. New threats stir in the dark.`, 'explore');
    for (let i = 0; i < 2; i++) spawnEnemy();
    // Aging flavour for old heroes
    for (const h of W.heroes) {
      const age = heroAge(h);
      if (age === HERO_AGE_THRESHOLD) {
        addLog(`${firstName(h)} grows gaunt with age, yet fights on.`, 'explore');
      } else if (age > HERO_AGE_THRESHOLD && age % 5 === 0) {
        addLog(`${firstName(h)}, survivor of ${age} years, remains unbowed.`, 'explore');
      }
    }
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

// Override hero mood (admin)
app.post('/api/admin/hero/mood', requireAdmin, (req, res) => {
  const { name, mood } = req.body;
  const hero = findHeroBySlugOrName(name);
  if (!hero) return res.status(404).json({ error: 'Hero not found' });
  if (!MOODS[mood]) return res.status(400).json({ error: 'Unknown mood' });
  setMood(hero, mood);
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, mood });
});

// Override hero traits (admin)
app.post('/api/admin/hero/traits', requireAdmin, (req, res) => {
  const { name, traits } = req.body;
  const hero = findHeroBySlugOrName(name);
  if (!hero) return res.status(404).json({ error: 'Hero not found' });
  const valid = (traits || []).filter(k => TRAITS[k]);
  if (!valid.length) return res.status(400).json({ error: 'No valid traits provided' });
  hero.traits = valid.slice(0, 3);
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, traits: hero.traits });
});

// Inject a custom chronicle entry (admin announcement / narrative injection)
app.post('/api/admin/announce', requireAdmin, (req, res) => {
  const { message, type } = req.body;
  const validTypes = ['explore', 'combat', 'loot', 'level', 'death'];
  const logType = validTypes.includes(type) ? type : 'explore';
  const msg = String(message || '').trim().slice(0, 200);
  if (!msg) return res.status(400).json({ error: 'Message required' });
  addLog(`[⚡] ${msg}`, logType);
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true });
});

// Force-spawn a new hero (admin)
app.post('/api/admin/spawn-hero', requireAdmin, (req, res) => {
  if (W.heroes.length >= 12) return res.status(400).json({ error: 'Too many heroes (max 12 in admin mode)' });
  spawnHero(false);
  const newHero = W.heroes[W.heroes.length - 1];
  addLog(`A shadow stirs — ${newHero.name} enters the world.`, 'explore');
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, heroName: newHero.name });
});

// Force-trigger a milestone for testing (admin)
app.post('/api/admin/trigger-milestone', requireAdmin, (req, res) => {
  const { key, heroName } = req.body;
  const def = MILESTONE_DEFS.find(d => d.key === key);
  if (!def) return res.status(400).json({ error: 'Unknown milestone key' });
  const hero = heroName ? findHeroBySlugOrName(heroName) : W.heroes[0];
  if (!hero) return res.status(404).json({ error: 'Hero not found' });
  // Force-fire regardless of condition
  delete W.worldFirsts[key];
  W.worldFirsts[key] = { heroName: hero.name, year: W.year, tick: W.tick };
  const msg = def.msg(hero);
  addLog(`✸ MILESTONE: ${msg}`, 'level');
  const milestoneMsg = `data: ${JSON.stringify({ type:'milestone', key, heroName: hero.name, message: msg, year: W.year })}\n\n`;
  for (const res of clients) { try { res.write(milestoneMsg); } catch(e) { clients.delete(res); } }
  res.json({ ok: true, message: msg });
});

// Add enemies to the world (admin)
app.post('/api/admin/spawn-enemy', requireAdmin, (req, res) => {
  const { count } = req.body;
  const n = Math.min(parseInt(count) || 1, 10);
  for (let i = 0; i < n; i++) spawnEnemy();
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, enemyCount: W.enemies.length });
});

// Remove all enemies (admin — clears battlefield)
app.post('/api/admin/clear-enemies', requireAdmin, (req, res) => {
  for (const h of W.heroes) {
    if (h.target) { h.target.engagedBy = null; h.target = null; }
    if (h.state === 'hunt') { h.state = 'explore'; h.stateTimer = 20; }
  }
  W.enemies = [];
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true });
});

// Force-toggle storm state (admin — for testing)
app.post('/api/admin/storm', requireAdmin, (req, res) => {
  const { active } = req.body;
  const newState = (active !== undefined) ? !!active : !W.stormActive;
  if (newState === W.stormActive) return res.json({ ok: true, stormActive: W.stormActive });
  W.stormActive = newState;
  W.stormTimer  = newState ? 150 + rng(250) : 300 + rng(400);
  const logMsg  = newState ? pick(STORM_START_MSGS) : pick(STORM_END_MSGS);
  addLog(logMsg, newState ? 'death' : 'explore');
  const stormMsg = `data: ${JSON.stringify({ type:'storm', active: newState })}\n\n`;
  for (const res of clients) { try { res.write(stormMsg); } catch(e) { clients.delete(res); } }
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, stormActive: W.stormActive });
});

// Force a cross-hero encounter (admin — for testing)
app.post('/api/admin/encounter', requireAdmin, (req, res) => {
  const exploring = W.heroes.filter(h => h.state === 'explore' && !h.retired);
  if (exploring.length < 2) return res.status(400).json({ error: 'Need at least 2 exploring heroes' });
  const a = exploring[0], b = exploring[1];
  const key   = encounterKey(a, b);
  const count = W.heroEncounters[key] || 0;
  W.heroEncounters[key] = count + 1;
  const tone  = count === 0 ? 'neutral' : count <= 2 ? 'familiar' : 'legendary';
  const msg   = pick(ENCOUNTER_LINES[tone])(a, b) + encounterMoodFlavour(a, b);
  addLog(msg, 'explore');
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, heroes: [a.name, b.name], tone, message: msg });
});

// Engagement stats (admin) — per-hero viewer data + world totals
app.get('/api/admin/engagement', requireAdmin, (req, res) => {
  res.json({
    totalWorldViewers: clients.size,
    heroes: W.heroes.map(h => ({
      name: h.name,
      heroPageViewers: heroViewerCount(h.name),
      dailyViewSeconds: getDailyView(h),
      presence: Math.round(h.presence || 0),
      presenceTier: getPresenceTier(h.presence).name,
      dramaScore: dramascoreOf(h),
      mood: h.mood || 'resolute',
      traits: h.traits || [],
      heroAge: heroAge(h),
      isAged: heroAge(h) >= HERO_AGE_THRESHOLD,
    })),
    worldFirsts: W.worldFirsts,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  TEST DATA — admin-only endpoints (flagged isMock:true for bulk deletion)
// ─────────────────────────────────────────────────────────────────────────────

// Seed world state (presence tiers, moods, aging) across existing heroes.
// Does NOT mark heroes as mock — this only adjusts sim state for visual testing.
app.post('/api/admin/seed-test-data', requireAdmin, (req, res) => {
  const presenceValues = [95, 70, 45, 10];
  const moodValues     = ['triumphant', 'haunted', 'vengeful', 'weary', 'resolute'];

  W.heroes.forEach((h, i) => {
    h.presence = presenceValues[i % presenceValues.length];
    h.mood     = moodValues[i % moodValues.length];
    h.moodText = MOODS[h.mood]?.desc || '';
    if (!h.traits || !h.traits.length) h.traits = pickTraits();
    if (i === 0) h.bornYear = Math.max(1, W.year - (HERO_AGE_THRESHOLD + 3));
    if (i === 0) { h.kills = 12; h.falls = 2; h.level = 4; h.xp = 30; }
    if (i === 1) { h.kills = 5;  h.falls = 4; h.level = 2; }
    if (i === 2) { h.kills = 20; h.falls = 0; h.level = 6; }
  });

  if (W.year < 5) W.year = 5;

  const seedLogs = [
    { msg:'[TEST] Presence tiers seeded across all heroes.', type:'explore' },
    { msg:'[TEST] Moods and history applied for validation.', type:'explore' },
  ];
  for (const entry of seedLogs.reverse()) {
    W.log.unshift({ ...entry, t: W.year });
    if (W.log.length > 40) W.log.pop();
  }

  saveState(W).catch(() => {});
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, message: 'World state seeded. Remove before production.' });
});

// Seed mock owner heroes — each gets a real claimToken and isMock:true flag.
// Names prefixed with [MOCK] for visual identification everywhere.
// Safe to call multiple times — skips if mock heroes already exist.
const MOCK_OWNER_PROFILES = [
  {
    nameSuffix: 'the Watcher',     firstName: 'Seraphel',
    traits: ['scholarly','tenacious'], mood: 'resolute',
    kills: 8, falls: 1, level: 3, xp: 20, presence: 72,
    motto: 'Knowledge is the sharpest blade.',
  },
  {
    nameSuffix: 'Darkheart',       firstName: 'Draven',
    traits: ['bloodthirsty','cursed'], mood: 'vengeful',
    kills: 24, falls: 3, level: 5, xp: 45, presence: 55,
    motto: 'I have made peace with the dark.',
  },
  {
    nameSuffix: 'Ashborne',        firstName: 'Lirien',
    traits: ['cautious','greedy'],  mood: 'haunted',
    kills: 2, falls: 5, level: 2, xp: 8, presence: 18,
    motto: '',
    bornYearOffset: HERO_AGE_THRESHOLD + 5,  // aged veteran
  },
];

app.post('/api/admin/seed-mock-owners', requireAdmin, (req, res) => {
  const existing = W.heroes.filter(h => h.isMock).map(h => h.name);
  const created  = [];

  for (const profile of MOCK_OWNER_PROFILES) {
    const heroName = `[MOCK] ${profile.firstName} ${profile.nameSuffix}`;
    if (W.heroes.some(h => h.name === heroName)) continue;   // already exists
    if (W.heroes.length >= 12) break;

    const usedImages  = new Set(W.heroes.map(h => h.image));
    const availImages = HERO_IMAGES.filter(i => !usedImages.has(i));
    const image       = availImages.length ? pick(availImages) : pick(HERO_IMAGES);
    const claimToken  = crypto.randomUUID();
    const baseAtk     = 3 + rng(4);
    const bornYear    = profile.bornYearOffset
      ? Math.max(1, W.year - profile.bornYearOffset)
      : W.year;

    const hero = {
      name: heroName,
      hp: 20 + rng(10), maxhp: 30 + profile.level * 5,
      atk: baseAtk + profile.level, baseAtk,
      xp: profile.xp, level: profile.level,
      loot: rng(profile.kills), kills: profile.kills, falls: profile.falls,
      color: HERO_COLORS[rng(HERO_COLORS.length)],
      state: 'explore', target: null, stateTimer: 20 + rng(20),
      isBlonde: false, fleeCount: profile.falls, image,
      claimToken,
      motto: profile.motto || '',
      retired: false, retiredAt: null,
      dailyViewSeconds: 0, dailyViewDay: null,
      presence: profile.presence,
      invokeUsedDay: null,
      traits: profile.traits,
      mood: profile.mood, moodText: MOODS[profile.mood]?.desc || '',
      bornYear,
      isMock: true,   // ← the deletion flag
    };

    // Mood text derived from existing setMood logic
    hero.hp = Math.min(hero.hp, hero.maxhp);
    W.heroes.push(hero);
    created.push({ heroName, claimToken });
    addLog(`[MOCK] ${profile.firstName} ${profile.nameSuffix} enters the world for testing.`, 'explore');
  }

  saveState(W).catch(() => {});
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({
    ok: true,
    created,
    skipped: existing,
    note: 'Tokens are one-time — store them now. Heroes flagged isMock:true for bulk deletion.',
  });
});

// Delete all mock heroes — removes any hero with isMock:true.
// Disengages active targets before removal.
app.delete('/api/admin/mock-heroes', requireAdmin, (req, res) => {
  const before = W.heroes.length;
  const removed = W.heroes.filter(h => h.isMock).map(h => h.name);

  for (const h of W.heroes.filter(h => h.isMock)) {
    if (h.target) { h.target.engagedBy = null; h.target = null; }
    // Close any open SSE connections for this hero
    const set = heroClients.get(h.name);
    if (set) {
      for (const res of set) { try { res.end(); } catch(e) {} }
      heroClients.delete(h.name);
    }
  }

  W.heroes = W.heroes.filter(h => !h.isMock);
  const after = W.heroes.length;

  if (removed.length) {
    addLog(`[ADMIN] ${removed.length} mock hero${removed.length > 1 ? 'es' : ''} removed from the world.`, 'death');
  }

  saveState(W).catch(() => {});
  broadcast({ type:'state', world: liveSnapshotWithViewers(), combatEvents:[] });
  res.json({ ok: true, removed, before, after });
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
    W.worldFirsts   = saved.worldFirsts   || {};
    W.stormActive   = saved.stormActive   || false;
    W.stormTimer    = saved.stormTimer    || (400 + rng(200));  // initial calm
    W.heroEncounters = saved.heroEncounters || {};
    W.heroes = (saved.heroes || []).map(h => ({
      name:h.name, hp:h.hp, maxhp:h.maxhp, atk:h.atk, baseAtk:h.baseAtk||h.atk,
      xp:h.xp||0, level:h.level||1, loot:h.loot||0, kills:h.kills||0, falls:h.falls||0,
      color:h.color||'#7060d0', state: h.state === 'wounded' ? 'wounded' : 'explore',
      target:null, stateTimer: h.state === 'wounded' ? (h.stateTimer||WOUNDED_RECOVERY_TICKS) : 0,
      isBlonde:h.isBlonde||false, fleeCount:h.fleeCount||0, image:h.image||HERO_IMAGES[0],
      claimToken: h.claimToken || null, motto: h.motto || '',
      retired: h.retired || false, retiredAt: h.retiredAt || null,
      dailyViewSeconds: h.dailyViewSeconds || 0, dailyViewDay: h.dailyViewDay || null,
      presence: h.presence || 0, invokeUsedDay: h.invokeUsedDay || null,
      traits: h.traits || pickTraits(),
      mood: h.mood || 'resolute', moodText: h.moodText || MOODS.resolute.desc,
      bornYear: h.bornYear || 1,
      isMock: h.isMock || false,
    }));
    W.enemies = (saved.enemies || []).map(e => ({
      id:enemyIdCounter++, name:e.name, hp:e.hp, maxhp:e.maxhp, atk:e.atk,
      xpReward:e.xpReward||5, tier:e.tier||1, state:'patrol', engagedBy:null
    }));
    console.log(`World restored — Year ${W.year}, Tick ${W.tick}`);
  } else {
    console.log('New world starting...');
    W.stormTimer = 400 + rng(200);   // first storm after initial calm
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
