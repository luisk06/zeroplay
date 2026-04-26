# Gothic RPG — Zero Player

A persistent, autonomous fantasy world that runs 24/7 without player input. Heroes fight, level up, die, and accumulate legends entirely on their own. Viewers watch in real time, shape the world through their presence, and can claim ownership of a hero to influence their fate.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Key Features](#2-key-features)
3. [System Architecture](#3-system-architecture)
4. [Tech Stack](#4-tech-stack)
5. [Getting Started](#5-getting-started)
6. [Project Structure](#6-project-structure)
7. [Core Concepts / Business Logic](#7-core-concepts--business-logic)
8. [API Reference](#8-api-reference)
9. [User Flow](#9-user-flow)
10. [Development Guidelines](#10-development-guidelines)
11. [Testing](#11-testing)
12. [Deployment](#12-deployment)
13. [Roadmap / Future Improvements](#13-roadmap--future-improvements)
14. [FAQ / Common Issues](#14-faq--common-issues)
15. [Contribution Guide](#15-contribution-guide)
16. [License](#16-license)

---

## 1. Project Overview

### What it is

Gothic RPG — Zero Player is a **zero-player game**: a self-running simulation where heroes autonomously explore a gothic world, engage in combat, find loot, level up, and occasionally fall. No player controls the heroes directly. The game runs continuously on the server, and users observe it like a living story.

### Core concept and goals

- **Autonomous simulation** — the world runs entirely server-side via a deterministic tick loop. The browser never touches game logic.
- **Viewer influence** — watching a hero's page builds *Presence*, a resource that makes the hero measurably stronger. Audience attention has mechanical consequences.
- **Ownership without accounts** — viewers can claim a hero using a secret token stored in `localStorage`. No registration required for the core experience.
- **Real-time broadcast** — all connected viewers see the same world state simultaneously via Server-Sent Events (SSE).
- **Scale-ready** — the broadcast pipeline serializes world state once per tick and writes the same string to all connected clients, keeping CPU cost flat as viewer count grows.

### Target users

| Audience | Why they're here |
|---|---|
| Casual viewers | Watch the simulation unfold in real time, root for a hero |
| Hero owners | Claim a hero, set their motto, invoke Presence abilities |
| Developers | Extend the simulation, add mechanics, connect services |
| Product / content teams | Understand the system to plan features, monetization, or partnerships |

---

## 2. Key Features

### Live now

- **Autonomous simulation** — heroes fight, flee, loot, level up, and recover from defeat without any input
- **Real-time SSE broadcast** — all viewers receive world updates simultaneously; state serialized once per tick
- **Presence system** — viewer attention accrues a Presence score (diminishing returns per extra viewer); unlocks four tiers: Unobserved → Noticed → Witnessed → Exalted, each granting ATK bonuses, XP multipliers, and healing
- **Invoke ability** — hero owners can spend 40 Presence for a 3× guaranteed crit hit; once per day per hero
- **Hero ownership** — claim a hero via `POST /api/join`; token stored in `localStorage`; no account required
- **Hero customization** — owners can rename their hero (unique names enforced) and set a motto
- **Hero retirement** — graceful exit; hero leaves the world permanently
- **Daily presence requirement** — each hero must have at least one viewer for 5 minutes per day; tracked via a gauge bar
- **Rank progression** — 8 ranks from Initiate to Undying, unlocked by level milestones
- **World map** — real D3 + Natural Earth geography (Japan); pan, zoom, click a hero marker to open their page
- **Leaderboard** — top 10 heroes by kills; shows combat state, Presence tier, viewer count
- **Event feed** — live chronicle of recent events, color-coded by type; new entries flash on arrival
- **Era progression** — world advances through named eras (Age of Shadow → Age of Blood → Age of Ash → Age of Ruin) over time
- **Admin dashboard** — HTTP Basic Auth protected; real-time hero stat editing, world speed/pause/reset controls
- **Slug URLs** — hero pages use `iron-wolf` style URLs, not `%20` encoded names
- **Persistence** — world state saved to Upstash Redis (primary) and local `save.json` (fallback) every 300 ticks

### Planned / in progress

- Account registration for post-ownership features
- Presence effects on hero stats from the main world viewer count (not just hero-page viewers)
- Permadeath conditions tied to the daily presence requirement
- Phase 2 ownership: claim → account binding
- Expanded era system with era-specific events and enemy types

---

## 3. System Architecture

### High-level overview

```
Browser (viewer)
    │
    ├── GET /              → index.html  (main world view)
    ├── GET /hero?name=X   → hero.html   (individual hero page)
    ├── GET /admin         → admin.html  (admin dashboard, Basic Auth)
    │
    ├── GET  /api/stream         → SSE: world state every 10 ticks
    ├── GET  /api/stream/hero    → SSE: per-hero state + combat events
    │
    └── POST /api/*              → control endpoints (join, rename, invoke, etc.)

Server (Node.js / Express)
    │
    ├── Simulation loop  (setInterval, STEP_MS = 120ms × simSpeed)
    │       └── tick() → updateHero() → broadcast()
    │
    ├── Presence ticker  (setInterval, 1s)
    │       └── tickPresence() — accrual / decay per hero
    │
    ├── Daily view ticker (setInterval, 1s)
    │       └── tickHeroDailyView() — 5-min daily gauge
    │
    └── Persistence      (every 300 ticks)
            ├── Upstash Redis  (primary, production)
            └── save.json      (fallback, local)
```

### Data flow (one tick cycle)

1. `setInterval` fires based on `STEP_MS / simSpeed`
2. `tick()` increments `W.tick`, calls `updateHero(h)` for every living hero
3. Each hero's state machine advances: `explore → hunt → flee → wounded → explore`
4. Combat events (hits, kills, level-ups) are pushed to `pendingCombatEvents[]`
5. Every 10 ticks, `liveSnapshotWithViewers()` serializes world state **once** to a JSON string
6. The same string is written to every SSE client in `clients` (Set)
7. Per-hero SSE streams get their own serialization (once per hero, not per viewer)
8. Every 300 ticks, `saveState()` persists to Redis + `save.json`

### Frontend rendering model

- All rendering is **display-only** — no simulation logic runs in the browser
- World state arrives via SSE and is applied to the DOM by `renderAll()`
- The hero detail panel uses `patchHeroDetail()` for in-place updates (no innerHTML rebuild, no flicker)
- The map is lazy-loaded (D3 + topojson only fetched when the map modal opens)
- Per-hero pages connect to `/api/stream/hero` for their own SSE channel

---

## 4. Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Runtime | Node.js | Single-threaded event loop — ideal for SSE + setInterval simulation |
| HTTP framework | Express 4 | Minimal overhead; straightforward SSE support |
| Real-time | Server-Sent Events (SSE) | One-directional push; no WebSocket overhead; auto-reconnects |
| Persistence | Upstash Redis (`@upstash/redis`) | Serverless-compatible HTTP Redis; survives Railway restarts |
| Persistence fallback | `save.json` (local file) | Zero-dependency fallback for local dev |
| Frontend | Vanilla JS (no framework) | Zero build step; all logic self-contained in HTML files |
| Map | D3 v7 + topojson-client | Industry-standard geo rendering; lazy-loaded from CDN |
| Map data | world-atlas@2 (Natural Earth 110m) | Free, well-maintained geographic data |
| Deployment | Railway | Persistent server process; not serverless (required for SSE + simulation loop) |
| Fonts | Google Fonts (MedievalSharp, IM Fell English) | Thematic; loaded via `@import` |

**Why not Vercel/Netlify?** The simulation requires a persistent Node process running a `setInterval` loop. Serverless platforms terminate after each request and cannot maintain this.

**Why SSE over WebSockets?** SSE is simpler (HTTP-only, no upgrade), auto-reconnects, and is sufficient for one-directional server→client push. The game never needs client→server real-time messaging.

---

## 5. Getting Started

### Prerequisites

- Node.js 18+
- npm
- (Optional) An [Upstash](https://upstash.com) Redis database for persistence in production

### Installation

```bash
git clone https://github.com/your-org/gothic-rpg.git
cd gothic-rpg
npm install
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `KV_REST_API_URL` | Production only | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Production only | Upstash Redis REST token |
| `ADMIN_USER` | Optional | Admin dashboard username (default: `admin`) |
| `ADMIN_PASS` | Optional | Admin dashboard password (default: `gothic2025`) |
| `PORT` | Optional | HTTP port (default: `3000`) |

For local development, no environment variables are required. World state persists to `save.json`.

Create a `.env` file (not committed) for local overrides:

```env
ADMIN_USER=admin
ADMIN_PASS=yourpassword
PORT=3000
```

> **Note:** The project does not currently use `dotenv`. Set env vars in your shell or Railway dashboard.

### Running locally

```bash
node server.js
```

Visit `http://localhost:3000` — the world starts immediately and populates itself.

Admin dashboard: `http://localhost:3000/admin` (Basic Auth prompt will appear).

### Resetting the world

From the admin dashboard → **⟳ Reset World**, or:

```bash
rm save.json
node server.js
```

---

## 6. Project Structure

```
gothic-rpg/
├── server.js                  # Entire backend: simulation, SSE, API routes
├── package.json
├── save.json                  # Local world state (auto-generated, gitignored)
├── .gitignore
│
└── public/                    # Static files served by Express
    ├── index.html             # Main world view (SSE client, map, leaderboard, feed)
    ├── hero.html              # Individual hero page (per-hero SSE, Presence UI)
    ├── admin.html             # Admin dashboard (Basic Auth protected)
    │
    ├── hero-red.png           # Hero portrait images (one per hero slot)
    ├── hero-blue.png
    ├── hero-green.png
    ├── hero-purple.png
    │
    ├── skeleton.jpg           # Enemy images (matched by name in JS)
    ├── ghoul.jpg
    ├── spider.jpg
    ├── shade.jpg
    ├── golem.jpg
    ├── spectre.jpg
    └── troll.jpg
```

### Key file responsibilities

| File | Responsibility |
|---|---|
| `server.js` | **Single source of truth for game logic.** Simulation tick, state machine, SSE broadcast, all API routes, persistence, admin auth. |
| `public/index.html` | World dashboard. Receives SSE, renders pulse strip, hero banner, event feed, leaderboard, collapsible hero grid, world map (D3). All rendering is display-only. |
| `public/hero.html` | Per-hero page. Connects to `/api/stream/hero`, renders Presence panel, combat arena, stat grid, rank strip, owner controls. |
| `public/admin.html` | Real-time admin controls. Edit any hero's stats live; control world speed/pause/reset. |

---

## 7. Core Concepts / Business Logic

### Simulation tick

The world runs at `STEP_MS = 120ms`, multiplied by `simSpeed` (1×, 2×, or 4×). Each tick, every hero's state machine advances. The tick loop never runs in the browser.

### Hero state machine

```
explore ──[finds enemy]──→ hunt ──[enemy dies]──→ explore
   ↑                          │
   │                    [hero HP < 25%]
   │                          ↓
   └──[timer expires]──── flee ──[timer expires]──→ explore
                              │
                        [hero HP ≤ 0]
                              ↓
                           wounded ──[timer expires]──→ explore
```

- **explore**: passive state; small chance of finding loot or engaging an enemy
- **hunt**: active combat; hero and enemy trade hits each tick based on probability
- **flee**: recovery jog; HP regenerates slowly; re-enters explore after timer
- **wounded**: knocked out; recovers HP slowly to 50%; re-enters explore after `WOUNDED_RECOVERY_TICKS` (300 ticks + random)
- **retired**: permanent; hero no longer ticks

### Hero defeat (no permadeath)

On defeat, a hero:

- Loses 30% of current XP
- Loses 1 ATK point (floored at `baseAtk`)
- Has HP reset to 25% of max
- Enters `wounded` state for 300–400 ticks
- Increments `falls` counter

### Rank system

| Rank | Min Level | Badge |
|---|---|---|
| Initiate | 1 | ◌ |
| Wanderer | 3 | ◈ |
| Veteran | 5 | ✦ |
| Champion | 8 | ❖ |
| Warlord | 12 | ⚔ |
| Deathlord | 17 | ☠ |
| Archon | 23 | ✸ |
| Undying | 30 | ★ |

### Presence system

Presence is a per-hero resource (0–100) that accrues while viewers watch the hero's page and decays when no one watches.

**Accrual formula (per second):**
```
delta = viewers / (viewers + 2)
```

This gives diminishing returns: 1 viewer = +0.33/s, 4 viewers = +0.67/s, 10 viewers = +0.83/s.

**Decay:** −0.2/s when viewer count = 0. A hero stays boosted for several minutes after viewers leave.

**Tiers and effects:**

| Tier | Presence | ATK | XP | Out-of-combat heal | In-combat heal |
|---|---|---|---|---|---|
| Unobserved | 0–29 | ×1.00 | ×1.00 | — | — |
| Noticed | 30–59 | ×1.10 | ×1.10 | — | — |
| Witnessed | 60–89 | ×1.20 | ×1.15 | 1 HP/tick | — |
| Exalted | 90–100 | ×1.35 | ×1.25 | 1 HP/tick | 1 HP/tick |

**Invoke:** Once per day (resets at UTC midnight), a hero's owner can spend 40 Presence to trigger a 3× guaranteed critical hit on the hero's next attack. Requires Presence ≥ 40 and the hero to be in `hunt` state.

### Hero ownership

Ownership is handled via a **claim token** — a `crypto.randomUUID()` generated server-side when a viewer joins the world via `POST /api/join`. The token is:

- Returned **once** in the join response (browser must store it immediately)
- Stored in `localStorage` under the key `gothic-rpg-claim` as `{ heroName, claimToken, createdAt }`
- Stored **plaintext** on the hero object server-side (this is a game token, not a credential)
- **Never** included in SSE broadcasts — only `hasClaim: true/false` is exposed publicly

Token-gated actions (rename, motto, retire, invoke) require both `heroName` and `claimToken` in the request body.

### Daily presence requirement

Each hero requires at least 300 seconds (5 minutes) of active hero-page viewership per UTC day. The `dailyViewSeconds` counter increments once per second while `heroClients` for that hero is non-empty. It resets at midnight UTC. A gauge bar on the hero page and the owner strip on the main page tracks progress.

### Era system

| Year range | Era name |
|---|---|
| 1–9 | Age of Shadow |
| 10–24 | Age of Blood |
| 25–49 | Age of Ash |
| 50+ | Age of Ruin |

Year advances every 600 ticks (~72 seconds at 1× speed). Enemy tier cap increases with year, allowing harder enemies to appear over time.

### Enemy tiers

| Tier | Enemies |
|---|---|
| 1 | Skeleton, Spider |
| 2 | Ghoul, Shade |
| 3 | Spectre, Golem |
| 4 | Troll |

Tier cap = `min(4, 1 + floor(year / 6))`.

### Broadcast optimization

World state is serialized **once** per broadcast cycle (every 10 ticks) using `JSON.stringify`. The resulting string is written directly to all SSE clients. Per-hero streams are serialized once per hero (not once per viewer). This keeps CPU cost O(1) with respect to viewer count.

---

## 8. API Reference

All endpoints are on the same Express server. No versioning prefix currently.

### SSE streams

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/stream` | None | World state SSE. Sends `{ type:'state', world, combatEvents }` every 10 ticks |
| `GET /api/stream/hero?name=<slug>` | None | Per-hero SSE. Sends `{ type:'hero', hero, viewers, world, combatEvents }` every 10 ticks |

Both streams accept slugs (`iron-wolf`) or exact names (`Iron Wolf`).

### Public endpoints

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/join` | — | Spawn a new hero; returns `{ ok, heroName, claimToken }` |
| `POST` | `/api/hero/verify` | `{ heroName, claimToken }` | Validate ownership |
| `POST` | `/api/hero/rename` | `{ heroName, claimToken, newName }` | Rename hero (unique names enforced) |
| `POST` | `/api/hero/motto` | `{ heroName, claimToken, motto }` | Set hero motto (max 80 chars) |
| `POST` | `/api/hero/retire` | `{ heroName, claimToken }` | Permanently retire hero |
| `POST` | `/api/hero/invoke` | `{ heroName, claimToken }` | Invoke Presence ability (once/day, costs 40 Presence) |

**Rate limits:** `POST /api/join` is limited to one new hero per 30 seconds globally; max 8 heroes in the world at once.

### Admin endpoints (Basic Auth)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin` | Admin dashboard HTML |
| `GET` | `/api/admin/heroes` | Full hero list with all fields |
| `POST` | `/api/admin/hero` | Update any hero field live |
| `POST` | `/api/speed` | Set simulation speed `{ speed: 1\|2\|4 }` |
| `POST` | `/api/pause` | Toggle simulation pause |
| `POST` | `/api/reset` | Wipe world state and restart |

### Hero data model (live snapshot fields)

```js
{
  name: "Iron Wolf",
  hp: 42, maxhp: 60, atk: 8, baseAtk: 6,
  xp: 34, level: 4, loot: 3, kills: 22,
  color: "#7060d0",
  state: "hunt",           // explore | hunt | flee | wounded | retired
  stateTimer: 112,
  isBlonde: false,
  fleeCount: 2, falls: 1,
  image: "hero-red.png",
  motto: "Death before dishonor.",
  hasClaim: true,
  dailyViewSeconds: 187, dailyViewGoal: 300,
  presence: 64,            // 0–100
  presenceMax: 100,
  presenceTier: "Witnessed",
  presenceAtkMult: 1.20,
  canInvoke: false,
  target: { name: "Ghoul", hp: 12, maxhp: 44 }, // null if not hunting
  heroViewers: 3           // added by liveSnapshotWithViewers()
}
```

---

## 9. User Flow

### First-time viewer

1. Lands on `/` — sees the pulse strip (live souls / year / kills / watching), event feed, leaderboard
2. Leaderboard and hero cards update in real time via SSE
3. Opens the map (◉ Map) — Japan geography with hero positions; can click a hero marker
4. Clicks a hero name or "View Hero Page" → navigates to `/hero?name=iron-wolf`
5. Hero page shows: combat arena (if fighting), Presence bar, stats, rank progression, chronicle
6. Staying on the hero page builds Presence — the bar fills, bonuses activate, changes reflect live

### Joining the world (claiming a hero)

1. Viewer clicks **⚔ Join the World** (hidden if `localStorage` already has a claim token)
2. Solves a simple math CAPTCHA to prevent automated joins
3. Server spawns a new hero, returns `{ heroName, claimToken }`
4. Browser stores claim in `localStorage`; header updates to show `★ HeroName` link; Join button hides
5. Hero's page and the main page both show a **★ Your Hero** badge
6. Owner can: rename the hero, set a motto, track the daily gauge, use Invoke

### Owner daily loop

1. Visits their hero page — daily gauge shows today's viewing progress (0–5 min)
2. Leaves the tab open — gauge fills in real time as `dailyViewSeconds` increments server-side
3. If Presence ≥ 40 and hero is in combat: **Invoke** button appears
4. Clicks Invoke — 40 Presence spent, next enemy hit deals 3× damage, golden flash fires in the arena

### Edge cases

- **Hero renamed:** `localStorage` claim updates automatically; URL changes to new slug via `history.replaceState`
- **Hero retired:** `localStorage` cleared; Join button reappears; hero stops ticking server-side
- **Claim token on wrong device:** No recovery mechanism in Phase 1 — the token lives only in `localStorage`
- **World full (8 heroes):** `/api/join` returns 400; viewer sees an error in the modal
- **Invalid slug in URL:** Server resolves slug → canonical name; returns null hero; page shows "Hero Not Found"
- **SSE disconnect:** Both `EventSource` clients reconnect automatically after 3 seconds

---

## 10. Development Guidelines

### Simulation logic belongs in `server.js` only

No game logic runs in the browser. The browser is a display client. If you find yourself computing a hero's next state in frontend JavaScript, move it to `server.js`.

### Adding a new hero mechanic

1. Add the field to `spawnHero()` with a default value
2. Add it to `serializeWorld()` (for persistence)
3. Add it to `liveHero()` and/or `liveSnapshot()` (for broadcast)
4. Restore it in `boot()` with a safe default (for save compatibility with existing data)
5. Implement the tick logic in `updateHero()` or a dedicated `setInterval`
6. Update the frontend to display it

### Adding a new API endpoint

1. Add the route to `server.js`
2. For owner-gated actions, validate `claimToken` against `hero.claimToken` before acting
3. Broadcast updated state after mutating world: `broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] })`

### Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Hero fields | camelCase | `dailyViewSeconds`, `presenceTier` |
| Server constants | UPPER_SNAKE | `WOUNDED_RECOVERY_TICKS`, `PRESENCE_MAX` |
| SSE message types | lowercase string | `'state'`, `'hero'`, `'viewers'` |
| CSS variables | `--kebab-case` | `--text-hi`, `--purple-dim` |
| CSS classes | kebab-case | `.feed-entry`, `.lb-combat-dot` |
| Hero slug | lowercase dashes | `iron-wolf`, `corvus-ironsoul` |

### Frontend patterns

- **Never rebuild innerHTML in a tight loop** — use the `patchHeroDetail()` pattern: update only changed DOM nodes
- **Detect new SSE entries before rendering** — compare keys/counts before replacing HTML to avoid flicker
- **Flash animations via CSS class toggle** — add class, force reflow (`void el.offsetWidth`), re-add, remove on `animationend`
- **Guard all `document.getElementById` calls** — elements may not exist on every page

### Code style

- 2-space indentation
- Single quotes in JS, double quotes in HTML attributes
- No build step, no transpilation — code must run in modern browsers natively
- Keep `server.js` as a single file — do not split into modules unless the file exceeds ~1500 lines

---

## 11. Testing

> **Note:** No automated test suite exists yet. The following describes the current validation practice and recommended strategy.

### Syntax validation (in practice)

```bash
node -c server.js

node -e "new Function(require('fs').readFileSync('public/index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1])"
```

### Manual smoke test checklist

Run this after every significant change:

- [ ] Server boots without errors: `node server.js`
- [ ] World populates within 5 seconds of boot
- [ ] SSE stream delivers updates: `curl -N http://localhost:3000/api/stream`
- [ ] Join flow: `POST /api/join` returns hero name and token
- [ ] Token validation: `POST /api/hero/verify` with correct/incorrect tokens
- [ ] Rename: unique name accepted, duplicate rejected (409)
- [ ] Admin auth: `/admin` prompts for credentials; wrong password → 401
- [ ] Map loads without console errors
- [ ] Presence accrues after 3+ seconds on a hero page
- [ ] World state persists across server restart (`save.json` populates)

### Recommended unit tests (to be added)

- `slugify()` edge cases (special characters, spaces, Unicode)
- `getPresenceTier()` at boundary values (29, 30, 59, 60, 89, 90)
- `presenceAtk()` and `presenceXp()` multiplier correctness
- `serializeWorld()` / `boot()` round-trip (save → restore → compare fields)
- `tick()` hero state transitions (explore → hunt → defeat → wounded → explore)

### Recommended integration tests

- SSE client count tracking (connect/disconnect increments and decrements `clients`)
- `heroClients` map key update on rename
- Invoke cooldown (same UTC day = blocked, next day = allowed)

---

## 12. Deployment

### Platform: Railway

The project is deployed on [Railway](https://railway.app). Railway provides a persistent Node.js process — essential for the `setInterval` simulation loop. Vercel, Netlify, and other serverless platforms are **not compatible**.

### Environment variables (set in Railway dashboard)

```
KV_REST_API_URL=https://your-db.upstash.io
KV_REST_API_TOKEN=your-token
ADMIN_USER=admin
ADMIN_PASS=yourpassword
```

### Deploy process

```bash
# Railway auto-deploys on push to the tracked branch
git push origin main
```

Railway detects `package.json`, runs `npm install`, and starts with `npm start` (`node server.js`).

### Persistence behaviour

On startup, `boot()` attempts to load world state from Redis first, then `save.json`. If neither exists, a fresh world is created and `repopulate()` spawns the starting heroes and enemies.

State is saved every 300 ticks (~36 seconds at 1× speed). On Railway, `save.json` is ephemeral and wiped on redeploy. **Redis is the only durable store in production.**

### Environments

| Environment | Notes |
|---|---|
| Production | Railway, Redis persistence, real domain |
| Development | Local `node server.js`, `save.json` persistence, no Redis required |

> There is no staging environment currently. Test significant changes locally before pushing to `main`.

---

## 13. Roadmap / Future Improvements

### Near term

- [ ] **Permadeath tied to daily requirement** — heroes that miss the 5-minute daily gauge for N consecutive days enter a vulnerable state and can die permanently
- [ ] **Main-page viewer influence** — total viewers on the main page affects world-level events (enemy spawn rate, loot frequency)
- [ ] **SSE keep-alive heartbeat** — send `: ping\n\n` every 25 seconds to prevent Railway's 30s idle timeout from closing streams
- [ ] **Hero page: Presence history** — small sparkline showing Presence over the last 24 hours

### Medium term

- [ ] **Phase 2 ownership: account registration** — bind claim token to an email/account for cross-device continuity
- [ ] **Hero achievements** — milestone badges for kills, falls, time alive, Presence milestones
- [ ] **World events** — era-specific scripted events (plagues, invasions, treasure hunts) that temporarily alter game rules
- [ ] **Admin: hero image upload** — let admins assign custom portraits rather than the fixed 4-image pool

### Known limitations

- **Max 8 heroes** — hardcoded; increasing requires testing SSE payload size and client render performance at scale
- **Claim token is device-local** — clearing `localStorage` permanently loses ownership with no recovery in Phase 1
- **No rate limiting on hero-page SSE** — a client could open many simultaneous hero streams
- **Single server process** — horizontal scaling is not supported; world state is in-memory

---

## 14. FAQ / Common Issues

**The world doesn't start / heroes don't appear**
→ Check that `repopulate()` ran in `boot()`. If `save.json` is corrupt, delete it and restart.

**SSE stream disconnects constantly**
→ Railway has a 30s idle timeout on HTTP connections. Add a `': ping\n\n'` heartbeat to the SSE handler every ~25 seconds. This is a known pending fix.

**Admin page returns 401**
→ Check `ADMIN_USER` and `ADMIN_PASS` environment variables. Default credentials are `admin` / `gothic2025`.

**Hero rename returns 409 Conflict**
→ Another hero already has that name (case-insensitive check). Try a different name.

**Map fails to load ("Map failed to load. Check connection.")**
→ jsDelivr CDN is unreachable. Check browser network tab. The map requires external CDN access for D3 v7 and world-atlas data.

**Presence doesn't build**
→ Presence only accrues via the hero-specific SSE stream (`/api/stream/hero`). It does **not** build from being on the main page. Open the hero's individual page.

**`git commit` fails with "index.lock exists"**
→ A previous git operation crashed and left a lock file. On Windows: delete `<repo-root>\.git\index.lock` manually. On Linux/Mac: `rm .git/index.lock`.

**Invoke button doesn't appear**
→ Three conditions must all be true simultaneously: `presence ≥ 40`, `hero.state === 'hunt'`, and `invokeUsedDay` ≠ today's UTC date. The SSE payload includes `canInvoke: true/false` for debugging.

**`save.json` is missing after Railway redeploy**
→ Expected — Railway's filesystem is ephemeral. This is why Redis is required in production. `save.json` is only reliable locally.

---

## 15. Contribution Guide

### Getting started

1. Fork the repository and clone your fork
2. Create a feature branch: `git checkout -b feature/my-change`
3. Make changes following the [Development Guidelines](#10-development-guidelines)
4. Run syntax checks: `node -c server.js`
5. Test manually using the smoke test checklist in [Testing](#11-testing)
6. Commit with a clear message describing the *why*, not just the *what*
7. Push and open a pull request against `main`

### PR expectations

- **One feature or fix per PR** — keep scope tight
- **No build artifacts** — do not commit `node_modules/` or generated files
- **Describe the change** — explain what changed and why in the PR description
- **Test evidence** — describe how you validated the change (browser test, curl output, etc.)
- **Backwards compatibility** — if you add fields to world state, always provide defaults in `boot()` so existing `save.json` / Redis saves don't break on restore

### What makes a good contribution

- New simulation mechanics that integrate cleanly with the existing tick loop
- Performance improvements to the broadcast pipeline
- Accessibility or mobile layout improvements
- Documentation corrections and additions

### Discuss first (open an issue before coding)

- Changes to the persistence schema (affects all live saves)
- New API endpoints (auth model needs agreement)
- Architectural changes (splitting `server.js`, adding an ORM, etc.)
- Anything that changes the core simulation formulas (affects all live heroes)

---

## 16. License

> **Note:** No license file has been added to the repository. Add one before making the project public.

This project is currently unlicensed. All rights reserved until a license is chosen.

Common options to consider:

- **MIT** — permissive; anyone can use, modify, and distribute freely
- **AGPL-3.0** — copyleft; anyone running a modified version publicly must share their source
- **Proprietary** — no redistribution permitted

Consult the project owner before contributing if licensing is unclear.
