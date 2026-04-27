# Gothic RPG — Zero Player

A persistent, autonomous fantasy world that runs 24/7 without player input. Heroes fight, level up, die, and accumulate legends entirely on their own. Viewers watch in real time, shape the world through their presence, and can claim ownership of a hero to influence their fate.

**Live:** https://zeroplay-production-c7ae.up.railway.app/

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
- **Viewer influence** — watching a hero's page builds *Presence*, a resource that makes the hero measurably stronger. World viewer count also matters — enough observers watching the main page creates a global crowd energy bonus.
- **Ownership with stakes** — viewers can claim a hero using a secret token stored in `localStorage`. Claimed heroes require regular check-ins: after 3 days of owner inactivity the hero enters a *forsaken* state; after 6 days they are permanently removed.
- **Real-time broadcast** — all connected viewers see the same world state simultaneously via Server-Sent Events (SSE).
- **Scale-ready** — the broadcast pipeline serializes world state once per tick and writes the same string to all connected clients, keeping CPU cost flat as viewer count grows.

### Target users

| Audience | Why they're here |
|---|---|
| Casual viewers | Watch the simulation unfold in real time, root for a hero |
| Hero owners | Claim a hero, set their motto, invoke Presence abilities, keep their hero alive |
| Developers | Extend the simulation, add mechanics, connect services |
| Product / content teams | Understand the system to plan features, monetization, or partnerships |

---

## 2. Key Features

### Live now

- **Autonomous simulation** — heroes fight, flee, loot, level up, and recover from defeat without any input
- **Real-time SSE broadcast** — all viewers receive world updates simultaneously; state serialized once per tick; 25-second keep-alive heartbeat prevents Railway idle timeouts
- **Hero Personality Traits** — each hero spawns with 2 of 8 permanent traits (Reckless, Cautious, Greedy, Bloodthirsty, Cowardly, Tenacious, Scholarly, Cursed) that modify combat, loot, and XP probabilities
- **Hero Emotional State** — 5 moods (Resolute, Haunted, Vengeful, Weary, Triumphant) that shift dynamically on kill, defeat, and recovery
- **Mortality Clock** — heroes age in world-years; veterans aged 15+ gain bonus XP and distinctive flavour lines
- **Presence system** — viewer attention accrues a Presence score (0–100) per hero; 4 tiers (Unobserved → Noticed → Witnessed → Exalted) grant ATK/XP bonuses and healing
- **Presence history sparkline** — 20-point SVG presence trend chart on each hero's page, sampled every 5 seconds
- **World viewer crowd bonus** — total world viewers amplify all heroes' ATK and XP (5 viewers: +5%, 20 viewers: +12%, 50+ viewers: +20%); label shown in pulse strip
- **Invoke ability** — hero owners can spend 40 Presence for a 3× guaranteed crit hit; once per UTC day
- **Hero ownership with forsaken stakes** — claim a hero via `POST /api/join`; token stored in `localStorage`; owner must check in at least once every 3 days or the hero enters a forsaken state; permanent removal at 6 days
- **Hero customization** — owners can rename their hero (unique names enforced) and set a motto
- **Hero retirement** — graceful exit; hero leaves the world permanently
- **Daily presence gauge** — each hero needs 5 minutes of hero-page viewership per UTC day; tracked with a gauge bar
- **Storm / Quiet cycle** — world oscillates between calm and storm; storms double engage chance, boost loot 50%, speed recovery; visualised with era bar pulse and crimson shadow
- **Cross-hero encounters** — pairs of exploring heroes occasionally meet; relationship tone escalates (neutral → familiar → legendary) across 3+ meetings; mood-flavoured commentary
- **Milestone system** — 7 world-first achievements broadcast as full-width banner notifications (first Level 5, 10 kills, Exalted Presence, etc.)
- **Directed Discovery spotlight** — first-time visitors see a session-gated card highlighting the most compelling hero (ranked by drama score)
- **Vigil viewer dots** — 5-dot cluster on the leaderboard replaces raw viewer counts; animated during combat
- **Rank progression** — 8 ranks from Initiate to Undying, unlocked by level milestones
- **World map** — real D3 + Natural Earth geography; pan, zoom, click hero markers
- **Leaderboard** — top 10 heroes by kills; shows combat state, Presence tier, mood emoji, trait names, viewer dots
- **Event feed** — live chronicle of recent events, color-coded by type; new entries flash on arrival
- **Era progression** — world advances through named eras (Age of Shadow → Age of Blood → Age of Ash → Age of Ruin) over time
- **Admin dashboard** — HTTP Basic Auth protected; 5-tab interface: World, Heroes, Engagement, Narrative, Chronicle; storm controls, encounter trigger, mock owner tools, drama score rankings
- **Mock owner system** — admin can seed test heroes with `isMock: true` flag for bulk deletion later
- **Rate limiting** — in-memory token bucket on all write endpoints (20 req/min public, 60 req/min admin)
- **Slug URLs** — hero pages use `iron-wolf` style URLs
- **Persistence** — world state saved to Upstash Redis (primary) and local `save.json` (fallback) every 300 ticks

### Planned / in progress

- Phase 2 ownership: account binding / cross-device via email magic links
- Claim ceremony (intermediate screen before finalizing hero claim)
- Private chronicle (per-hero diary visible only to owner)
- Owner whispers (once-daily targeted message that flavours the hero's next log entry)
- World events / scripted era events (plagues, invasions, treasure hunts)
- Achievement / badge system with visual unlock sequences
- Hall of Fame page for retired and fallen heroes
- Era skin / world visual theme changes per era

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
    ├── GET  /api/stream              → SSE: world state every 10 ticks + 25s ping
    ├── GET  /api/stream/hero?name=X  → SSE: per-hero state + combat events + 25s ping
    │
    └── POST /api/*                   → control endpoints (join, rename, invoke, etc.)

Server (Node.js / Express)
    │
    ├── Simulation loop  (setInterval, STEP_MS = 120ms × simSpeed)
    │       └── tick() → tickStorm() → tickWorldViewerInfluence() → updateHero()
    │                  → tickEncounters() every 200 ticks
    │                  → broadcast() every 10 ticks
    │
    ├── Presence ticker  (setInterval, 1s)
    │       └── tickPresence() — accrual / decay per hero + sparkline history
    │
    ├── Daily view ticker (setInterval, 1s)
    │       └── tickHeroDailyView() — 5-min daily gauge
    │
    ├── Forsaken checker (setInterval, 60s)
    │       └── tickForsaken() — inactivity warning / permadeath
    │
    └── Persistence      (every 300 ticks)
            ├── Upstash Redis  (primary, production)
            └── save.json      (fallback, local)
```

### Data flow (one tick cycle)

1. `setInterval` fires based on `STEP_MS / simSpeed`
2. `tick()` increments `W.tick`, runs `tickStorm()`, `tickWorldViewerInfluence()`, then `updateHero(h)` for every living hero
3. Each hero's state machine advances: `explore → hunt → flee → wounded → explore`
4. Combat events (hits, kills, level-ups) are pushed to `pendingCombatEvents[]`
5. Every 200 ticks, `tickEncounters()` checks all exploring hero pairs for chance encounters
6. Every 10 ticks, `liveSnapshotWithViewers()` serializes world state **once** to a JSON string
7. The same string is written to every SSE client in `clients` (Set)
8. Per-hero SSE streams get their own serialization (once per hero, not once per viewer)
9. Every 300 ticks, `saveState()` persists to Redis + `save.json`

### Frontend rendering model

- All rendering is **display-only** — no simulation logic runs in the browser
- World state arrives via SSE and is applied to the DOM by `renderAll()`
- The hero detail panel uses `patchHeroDetail()` for in-place updates (no innerHTML rebuild, no flicker)
- The map is lazy-loaded (D3 + topojson only fetched when the map modal opens)
- Per-hero pages connect to `/api/stream/hero` for their own SSE channel
- Presence sparkline rendered as inline SVG from a 20-point history array in the SSE payload

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
    ├── hero.html              # Individual hero page (per-hero SSE, Presence UI, sparkline)
    ├── admin.html             # Admin dashboard (5 tabs, Basic Auth protected)
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
| `server.js` | **Single source of truth for game logic.** Simulation tick, state machine, SSE broadcast, all API routes, persistence, admin auth, rate limiting, forsaken checker. |
| `public/index.html` | World dashboard. Receives SSE, renders pulse strip (incl. world viewer label), hero banner, event feed, leaderboard with vigil dots, spotlight card, storm effects, collapsible hero grid, world map (D3). |
| `public/hero.html` | Per-hero page. Connects to `/api/stream/hero`, renders Presence panel with sparkline, forsaken warning strip, combat arena, stat grid, rank strip, trait chips, mood badge, age badge, owner controls. |
| `public/admin.html` | 5-tab admin panel: World (controls, storm, mock owners), Heroes (live cards with drama score), Engagement (sorted grid + milestones), Narrative (announce, mood/trait override), Chronicle (world log). |

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

### Hero defeat

On defeat, a hero:

- Loses 30% of current XP
- Loses 1 ATK point (floored at `baseAtk`)
- Has HP reset to 25% of max
- Enters `wounded` state for 300–400 ticks
- Increments `falls` counter
- Mood shifts: Haunted (falls ≥ 3), Vengeful (kills ≥ 5), otherwise Weary

### Hero Personality Traits

Each hero spawns with 2 of 8 permanent traits that modify numeric probabilities each tick:

| Trait | Engage | Flee | Loot | XP |
|---|---|---|---|---|
| Reckless | +0.03 | −0.08 | — | — |
| Cautious | −0.02 | +0.06 | — | — |
| Greedy | — | — | +0.003 | — |
| Bloodthirsty | +0.02 | −0.05 | — | +10% |
| Cowardly | −0.03 | +0.10 | — | −5% |
| Tenacious | +0.01 | −0.06 | — | +5% |
| Scholarly | — | — | +0.002 | +15% |
| Cursed | +0.02 | — | −0.001 | — |

### Hero Emotional State

Moods shift dynamically and add narrative flavour:

| Mood | Emoji | Trigger |
|---|---|---|
| Resolute | ⚔ | Default; on recovery from Haunted/Weary |
| Haunted | 👁 | Defeated 3+ times |
| Vengeful | 🔥 | Defeated while having 5+ kills |
| Weary | 💤 | Defeated (falls < 3) |
| Triumphant | ✨ | On kill (unless Vengeful) |

### Mortality Clock

Heroes age in world-years (`heroAge = W.year - bornYear`). Heroes aged ≥ 15 years:
- Earn 1.15× XP per kill
- Receive special flavour log entries at ages 15, 20, 25, etc.
- Display an "Aged Veteran" badge on their hero page

### Presence system

Presence is a per-hero resource (0–100) that accrues while viewers watch the hero's page and decays when no one watches.

**Accrual formula (per second):**
```
delta = viewers / (viewers + 2)
```

This gives diminishing returns: 1 viewer = +0.33/s, 4 viewers = +0.67/s, 10 viewers = +0.83/s.

**Decay:** −0.2/s when viewer count = 0.

**Tiers and effects:**

| Tier | Presence | ATK | XP | Out-of-combat heal | In-combat heal |
|---|---|---|---|---|---|
| Unobserved | 0–29 | ×1.00 | ×1.00 | — | — |
| Noticed | 30–59 | ×1.10 | ×1.10 | — | — |
| Witnessed | 60–89 | ×1.20 | ×1.15 | 1 HP/tick | — |
| Exalted | 90–100 | ×1.35 | ×1.25 | 1 HP/tick | 1 HP/tick |

**Presence history:** A 20-point array sampled every 5 seconds powers a live SVG sparkline on the hero page.

**Invoke:** Once per UTC day, a hero's owner can spend 40 Presence to trigger a 3× guaranteed critical hit on the hero's next attack. Requires Presence ≥ 40 and `hunt` state.

### World viewer crowd bonus

The total count of viewers on the main world page (`clients.size`) creates a tiered global multiplier applied to all heroes' ATK and XP:

| Viewers | ATK/XP mult | Label |
|---|---|---|
| < 5 | ×1.00 | — |
| 5+ | ×1.05 | "the crowd stirs" |
| 20+ | ×1.12 | "the crowd roars" |
| 50+ | ×1.20 | "the realm awakens" |

When a tier threshold is crossed, a log entry fires and the label appears in the pulse strip.

### Forsaken / permadeath

Claimed heroes have a `lastActiveDay` clock updated whenever the owner visits the hero page or uses Invoke.

| Inactivity | Consequence |
|---|---|
| < 3 days | No effect |
| 3 days | Hero enters `forsaken` state; warning broadcast to all viewers; red strip on hero page |
| 6 days | Hero permanently removed; final SSE broadcast; `W.totalDeaths++` |

Unclaimed heroes and mock heroes (`isMock: true`) are never forsaken.

### Storm / Quiet cycle

The world alternates between calm and storm phases:

- **Calm:** 300–700 ticks; initial calm is 400–600 ticks before the first storm
- **Storm:** 150–400 ticks; atmospheric log entry fires on start and end

Storm modifiers applied during storm ticks:

| Mechanic | Modifier |
|---|---|
| Engage chance | ×2.0 |
| Loot chance | ×1.5 |
| Wounded recovery speed | ×0.75 (slower tick burn = faster return) |

Visualised client-side: era bar pulses red, `#app` gets crimson box shadow, ⚡ badge appears.

### Cross-hero encounters

Every 200 ticks, all pairs of exploring heroes have a 1.5% chance per pair of crossing paths. History is tracked by sorted pair key (`"A|B"`). Tone escalates with encounter count:

| Count | Tone | Flavour |
|---|---|---|
| 0 | Neutral | Brief acknowledgment |
| 1–2 | Familiar | Grim recognition |
| 3+ | Legendary | Veteran survivors |

Mood combinations add additional overlay text (e.g. both Vengeful, one Triumphant + one Weary). Trait contrasts (Reckless vs. Cautious) append further commentary. An `encounter` SSE event fires to both heroes' page viewers.

### Drama score

Used to rank heroes for the Directed Discovery spotlight and the Engagement admin tab:

```
score = (kills × 2) + (level × 3) + (falls × 4) + (presence / 10)
      + combatBonus (15 if hunting)
      + woundedBonus (8 if wounded)
      + viewerBonus (heroViewers × 5)
      + moodBonus (10 if Vengeful, 7 if Haunted)
      + ageBonus (6 if aged ≥ 15 years)
```

### Milestone system

7 world-first achievements tracked in `W.worldFirsts`. Each fires once, emits a `milestone` SSE event, and renders as a gold-bordered full-width banner:

| Key | Trigger |
|---|---|
| `first_level5` | Any hero reaches Level 5 |
| `first_level8` | Any hero reaches Level 8 |
| `first_level12` | Any hero reaches Level 12 |
| `first_kills10` | Any hero reaches 10 kills |
| `first_kills50` | Any hero reaches 50 kills |
| `first_falls5` | Any hero falls 5 times |
| `first_exalted` | Any hero reaches 90 Presence |

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

### Hero ownership

Ownership is handled via a **claim token** — a `crypto.randomUUID()` generated server-side when a viewer joins the world via `POST /api/join`. The token is:

- Returned **once** in the join response (browser must store it immediately)
- Stored in `localStorage` under the key `gothic-rpg-claim` as `{ heroName, claimToken, createdAt }`
- Stored **plaintext** on the hero object server-side (this is a game token, not a credential)
- **Never** included in SSE broadcasts — only `hasClaim: true/false` is exposed publicly

Token-gated actions (rename, motto, retire, invoke) require both `heroName` and `claimToken` in the request body.

### Era system

| Year range | Era name |
|---|---|
| 1–9 | Age of Shadow |
| 10–24 | Age of Blood |
| 25–49 | Age of Ash |
| 50+ | Age of Ruin |

Year advances every 600 ticks (~72 seconds at 1× speed). Enemy tier cap increases with year.

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

### Rate limiting

All write endpoints are protected by an in-memory token bucket (per-IP, resets every 60 seconds):

- **Public endpoints** (`/api/join`, `/api/hero/*`): 20 requests/min
- **Admin endpoints** (`/api/admin/*`): 60 requests/min

Exceeded limits return HTTP 429.

---

## 8. API Reference

All endpoints are on the same Express server. No versioning prefix currently.

### SSE streams

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/stream` | None | World state SSE. Sends `{ type:'state', world, combatEvents }` every 10 ticks; `: ping` comment every 25s |
| `GET /api/stream/hero?name=<slug>` | None | Per-hero SSE. Sends `{ type:'hero', hero, viewers, world, combatEvents }` every 10 ticks; `: ping` every 25s |

Both streams accept slugs (`iron-wolf`) or exact names (`Iron Wolf`).

SSE message types: `state`, `hero`, `viewers`, `milestone`, `storm`, `hero-event` (encounters), `forsaken-warn`, `forsaken-removed`.

### Public endpoints (rate-limited: 20/min per IP)

| Method | Endpoint | Body | Description |
|---|---|---|---|
| `POST` | `/api/join` | — | Spawn a new hero; returns `{ ok, heroName, claimToken }` |
| `POST` | `/api/hero/verify` | `{ heroName, claimToken }` | Validate ownership; touches `lastActiveDay` |
| `POST` | `/api/hero/rename` | `{ heroName, claimToken, newName }` | Rename hero (unique names enforced) |
| `POST` | `/api/hero/motto` | `{ heroName, claimToken, motto }` | Set hero motto (max 80 chars) |
| `POST` | `/api/hero/retire` | `{ heroName, claimToken }` | Permanently retire hero |
| `POST` | `/api/hero/invoke` | `{ heroName, claimToken }` | Invoke Presence ability (once/day, costs 40 Presence); touches `lastActiveDay` |

**Additional limits:** `/api/join` has a 30-second global cooldown between spawns; max 8 heroes in the world at once.

### Admin endpoints (Basic Auth + 60/min rate limit)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/admin` | Admin dashboard HTML |
| `GET` | `/api/admin/heroes` | Full hero list with all fields |
| `POST` | `/api/admin/hero` | Update any hero field live |
| `POST` | `/api/admin/hero/mood` | Override a hero's mood |
| `POST` | `/api/admin/hero/traits` | Override a hero's traits |
| `POST` | `/api/admin/announce` | Inject a custom log entry |
| `POST` | `/api/admin/spawn-hero` | Force-spawn a new hero |
| `POST` | `/api/admin/spawn-enemy` | Add enemies to the world |
| `POST` | `/api/admin/clear-enemies` | Remove all enemies |
| `POST` | `/api/admin/storm` | Force-toggle storm state |
| `POST` | `/api/admin/encounter` | Force a cross-hero encounter |
| `POST` | `/api/admin/trigger-milestone` | Force-trigger a milestone for testing |
| `GET` | `/api/admin/engagement` | Per-hero viewer + presence analytics |
| `POST` | `/api/admin/seed-mock-owners` | Seed 3 mock heroes with pre-set stats and `isMock: true` |
| `DELETE` | `/api/admin/mock-heroes` | Bulk-delete all heroes with `isMock: true` |
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
  presenceHistory: [58, 60, 61, 63, 64, ...],  // 20-point sparkline data
  canInvoke: false,
  target: { name: "Ghoul", hp: 12, maxhp: 44 },
  heroViewers: 3,
  traits: [{ key: "reckless", label: "Reckless" }, { key: "tenacious", label: "Tenacious" }],
  mood: "triumphant",
  moodLabel: "Triumphant", moodEmoji: "✨", moodDesc: "Riding high on victory.",
  bornYear: 32, heroAge: 14, isAged: false,
  isMock: false,
  forsaken: false,
  dramaScore: 87           // liveSnapshot only, not liveHero
}
```

---

## 9. User Flow

### First-time visitor

1. Lands on `/` — sees the pulse strip (souls / year / kills / in-combat / watching + crowd label if ≥5 viewers), event feed, leaderboard
2. A **spotlight card** appears above the era bar (once per session) highlighting the highest drama-score hero
3. Leaderboard and hero cards update in real time via SSE
4. Opens the map (◉ Map) — geography with hero positions; can click a hero marker
5. Clicks a hero name → navigates to `/hero?name=iron-wolf`
6. Hero page shows: combat arena (if fighting), Presence bar with sparkline, stats, rank progression, trait chips, mood badge, chronicle
7. Staying on the hero page builds Presence — bar fills, bonuses activate, changes reflect live

### Joining the world (claiming a hero)

1. Viewer clicks **⚔ Join the World** (hidden if `localStorage` already has a claim token)
2. Solves a simple math CAPTCHA to prevent automated joins
3. Server spawns a new hero with random traits and resolute mood, returns `{ heroName, claimToken }`
4. Browser stores claim in `localStorage`; header updates to show `★ HeroName` link; Join button hides
5. Owner can: rename the hero, set a motto, track the daily gauge, use Invoke

### Owner daily loop

1. Visits their hero page — daily gauge shows today's viewing progress (0–5 min); `lastActiveDay` is touched, resetting the forsaken clock
2. Leaves the tab open — gauge fills; Presence accrues
3. If Presence ≥ 40 and hero is in combat: **Invoke** button appears
4. Clicks Invoke — 40 Presence spent, next enemy hit deals 3× damage, golden flash fires in the arena
5. If 3+ days pass without visiting: forsaken warning strip appears on hero page
6. If 6+ days pass: hero is permanently removed

### Edge cases

- **Hero renamed:** `localStorage` claim updates automatically; URL changes via `history.replaceState`
- **Hero retired:** `localStorage` cleared; Join button reappears; hero stops ticking server-side
- **Hero forsaken:** owner returns and calls `/api/hero/verify` → `forsaken` flag cleared, warning strip disappears
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
2. Add `publicRateLimit` or `requireAdmin` (which includes `adminRateLimit`) as middleware
3. For owner-gated actions, validate `claimToken` against `hero.claimToken` before acting
4. Broadcast updated state after mutating world: `broadcast({ type:'state', world: liveSnapshot(), combatEvents:[] })`

### Naming conventions

| Thing | Convention | Example |
|---|---|---|
| Hero fields | camelCase | `dailyViewSeconds`, `presenceTier`, `lastActiveDay` |
| Server constants | UPPER_SNAKE | `WOUNDED_RECOVERY_TICKS`, `FORSAKEN_WARN_DAYS` |
| SSE message types | lowercase string | `'state'`, `'milestone'`, `'forsaken-warn'` |
| CSS variables | `--kebab-case` | `--text-hi`, `--purple-dim` |
| CSS classes | kebab-case | `.feed-entry`, `.vigil-dot`, `.trait-chip` |
| Hero slug | lowercase dashes | `iron-wolf`, `corvus-ironsoul` |

### Frontend patterns

- **Never rebuild innerHTML in a tight loop** — use the `patchHeroDetail()` pattern: update only changed DOM nodes
- **Detect new SSE entries before rendering** — compare keys/counts before replacing HTML to avoid flicker
- **Flash animations via CSS class toggle** — add class, force reflow (`void el.offsetWidth`), re-add, remove on `animationend`
- **Guard all `document.getElementById` calls** — elements may not exist on every page
- **SVG sparklines** — built from `presenceHistory[]` array; update `polyline` `points` attribute directly, no library needed

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
# Server
node --check server.js

# HTML script blocks
node -e "
const fs = require('fs');
['index.html','hero.html','admin.html'].forEach(f => {
  const src = fs.readFileSync('public/' + f, 'utf8');
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => {
    try { new Function(s); }
    catch(e) { console.error(f + ' block ' + i + ': ' + e.message); process.exit(1); }
  });
  console.log(f + ' OK');
});
"
```

### Manual smoke test checklist

Run this after every significant change:

- [ ] Server boots without errors: `node server.js`
- [ ] World populates within 5 seconds of boot
- [ ] SSE stream delivers updates: `curl -N http://localhost:3000/api/stream`
- [ ] Keep-alive ping visible in SSE stream after 25s (`: ping` comment line)
- [ ] Join flow: `POST /api/join` returns hero name and token
- [ ] Token validation: `POST /api/hero/verify` with correct/incorrect tokens; `lastActiveDay` updated on success
- [ ] Rename: unique name accepted, duplicate rejected (409)
- [ ] Admin auth: `/admin` prompts for credentials; wrong password → 401
- [ ] Rate limit: > 20 rapid POSTs to `/api/hero/verify` → 429
- [ ] Storm: admin force-toggle → era bar pulses red, log entry fires
- [ ] Encounter: admin force-encounter → log entry appears, both hero-page SSEs receive `hero-event`
- [ ] Sparkline: hero page presence sparkline renders after ~10 seconds on the page
- [ ] Forsaken: `lastActiveDay` set in verify response; `forsaken` field false
- [ ] Map loads without console errors
- [ ] Presence accrues after 3+ seconds on a hero page
- [ ] World state persists across server restart (`save.json` populates, includes `presenceHistory`, `traits`, `heroEncounters`)

### Recommended unit tests (to be added)

- `slugify()` edge cases (special characters, spaces, Unicode)
- `getPresenceTier()` at boundary values (29, 30, 59, 60, 89, 90)
- `presenceAtk()` / `presenceXp()` — presence tier × world viewer crowd mult stacking
- `worldViewerMult()` at tier boundaries (4, 5, 19, 20, 49, 50)
- `daysBetween()` — boundary at 3 and 6 days
- `dramascoreOf()` — each bonus component in isolation
- `serializeWorld()` / `boot()` round-trip including new fields (`traits`, `mood`, `forsaken`, `presenceHistory`)
- `tick()` hero state transitions (explore → hunt → defeat → wounded → explore)
- Storm modifiers: engage/loot chance during `stormActive: true`

---

## 12. Deployment

### Platform: Railway

The project is deployed on [Railway](https://railway.app). Railway provides a persistent Node.js process — essential for the `setInterval` simulation loop and SSE keep-alive. Vercel, Netlify, and other serverless platforms are **not compatible**.

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

### SSE and Railway idle timeout

Railway terminates HTTP connections idle for more than 30 seconds. Both SSE endpoints send a `: ping\n\n` comment every 25 seconds to keep connections alive. The `heartbeat` interval is stored per-connection and cleared on `req.on('close')` to prevent leaks.

### Environments

| Environment | Notes |
|---|---|
| Production | Railway, Redis persistence, real domain |
| Development | Local `node server.js`, `save.json` persistence, no Redis required |

> There is no staging environment currently. Test significant changes locally before pushing to `main`.

---

## 13. Roadmap / Future Improvements

### Near term

- [ ] **Claim ceremony** — intermediate fullscreen screen before finalizing hero claim; shows traits, mood, age
- [ ] **Private chronicle** — per-hero event diary visible only to the owner; never in `liveSnapshot`
- [ ] **Owner whispers** — once-daily message that flavours the hero's next log entry after 48 ticks
- [ ] **World events** — scripted era events (Plague Year, Invasion, Treasure Hunt) tied to tick/year thresholds
- [ ] **Achievement badges** — per-hero unlock system for milestones like first kill, 10 falls, 100 kills

### Medium term

- [ ] **Phase 2 ownership: account binding** — email magic link stores token server-side; cross-device ownership
- [ ] **Hall of Fame** — `/hall` page with retired and permadeath'd heroes, final stats, mood at death
- [ ] **Hero image optimization** — convert 2.3–2.5MB PNGs to WebP at ≤480px; target < 100KB each
- [ ] **Advanced hero grid filters** — filter by state, level, tier, mood, trait in the hero browse panel
- [ ] **Era skin / visual themes** — CSS palette and background texture changes per era (Age of Shadow → Ruin)

### Long term

- [ ] **Fate system** — weekly viewer vote on one of three world events to trigger
- [ ] **Horizontal scaling** — Redis pub/sub for multi-process SSE broadcast

### Known limitations

- **Max 8 heroes** — hardcoded; increasing requires testing SSE payload size and client render performance at scale
- **Claim token is device-local** — clearing `localStorage` permanently loses ownership with no recovery in Phase 1
- **Single server process** — horizontal scaling is not supported; world state is in-memory
- **Hero images are large** — current PNGs are 2.3–2.5MB each; WebP conversion recommended before scaling

---

## 14. FAQ / Common Issues

**The world doesn't start / heroes don't appear**
→ Check that `repopulate()` ran in `boot()`. If `save.json` is corrupt, delete it and restart.

**SSE stream disconnects constantly**
→ The 25-second keep-alive heartbeat (`': ping\n\n'`) should prevent Railway's idle timeout. If disconnects persist, check that the server is not crashing (look for uncaught exceptions in Railway logs).

**Admin page returns 401**
→ Check `ADMIN_USER` and `ADMIN_PASS` environment variables. Default credentials are `admin` / `gothic2025`.

**Hero rename returns 409 Conflict**
→ Another hero already has that name (case-insensitive check). Try a different name.

**Map fails to load ("Map failed to load. Check connection.")**
→ jsDelivr CDN is unreachable. Check browser network tab. The map requires external CDN access for D3 v7 and world-atlas data.

**Presence doesn't build**
→ Presence only accrues via the hero-specific SSE stream (`/api/stream/hero`). It does **not** build from the main page. Open the hero's individual page.

**Invoke button doesn't appear**
→ Three conditions must all be true simultaneously: `presence ≥ 40`, `hero.state === 'hunt'`, and `invokeUsedDay` ≠ today's UTC date. The SSE payload includes `canInvoke: true/false` for debugging.

**Hero shows forsaken warning but owner just visited**
→ Verify that `POST /api/hero/verify` was called with the correct `claimToken`. A successful verify response sets `lastActiveDay` to today and clears `forsaken`. If the token is wrong, the request returns 403 and the clock is not touched.

**Rate limit hit (429)**
→ Public write endpoints allow 20 requests per minute per IP. If testing rapidly, wait 60 seconds for the bucket to reset. Admin endpoints allow 60 per minute.

**`save.json` is missing after Railway redeploy**
→ Expected — Railway's filesystem is ephemeral. This is why Redis is required in production. `save.json` is only reliable locally.

**`git commit` fails with "index.lock exists"**
→ A previous git operation crashed and left a lock file. On Linux/Mac: `rm .git/index.lock`.

---

## 15. Contribution Guide

### Getting started

1. Fork the repository and clone your fork
2. Create a feature branch: `git checkout -b feature/my-change`
3. Make changes following the [Development Guidelines](#10-development-guidelines)
4. Run syntax checks (see [Testing](#11-testing))
5. Test manually using the smoke test checklist
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
