# Gothic RPG — Zero Player

A self-running gothic RPG simulation with persistent world state.

## Install & run

```bash
cd gothic-rpg
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## How persistence works

- The world auto-saves to `save.json` every ~300 simulation ticks and on page close.
- On next visit the server restores heroes, enemies, year, stats, and the chronicle log exactly where you left off.
- The **Reset World** button (top-right) wipes `save.json` and restarts from Year 1.

## Files

```
gothic-rpg/
├── server.js          # Express server — serves the app + handles save/load/reset
├── package.json
├── save.json          # Auto-created on first save (gitignore this if needed)
└── public/
    ├── index.html     # Full simulation + UI
    └── character.gif  # Kael the Stranger sprite
```
