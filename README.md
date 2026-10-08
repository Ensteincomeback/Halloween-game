# 🎃 Knock

> Knock on doors. Collect candy. Don't get caught by what's behind them.

**Season 0 MVP** of *Knock: On-Chain Trick-or-Treat*. As the design doc recommends, this
is the **off-chain fun loop with no token, no wallet and no fees**. Its job is to prove
that players say "one more door" before any economy is built on top.

## Run it

```bash
npm start          # http://localhost:3000
npm test           # game-rule tests (node:test, no dependencies)
```

Requires Node 20+. There are no npm dependencies. State is saved to `data/state.json`
(change it with `DATA_FILE=...`, and the port with `PORT=...`).

## What's in Season 0

| Design doc feature | Where |
| --- | --- |
| Knock loop with the 7-outcome odds table (64% pay out / 36% trick, scare, ambush) | `season/*.json` → `odds`, `server/game.js` `buildOdds` |
| House modifiers shift the table within protocol caps | `houseTypes`, `caps` |
| Visible **tells** (flickering lights, strange noises…) that hint at each house's hidden daily mood, honest 75% of the time | `moods` |
| **Pity timer**: rare-or-better guaranteed within 40 knocks | `pity` |
| **Jackpot** (Golden Pumpkin) ≈ 0.1% of knocks, globally rate-limited per day | `rewards.jackpot*` |
| **Bag vs. Stash**: only bag candy can be lost; walk home to bank | `bank` |
| **Nightfall**: danger and candy value rise as a session goes on; going home resets it | `nightfall` |
| **Scare mini-game** timed by the server (flinch early or freeze = lose a little bag candy) | `resolveScare` |
| **NPC monster ambushes**: read the clue, pick the counter (salt vs. ghost, flashlight vs. shade…); costume matchups; steal cap 10% of bag; 20-minute shield; same monster can't hit you twice in 6h; no ambushes in your first 10 knocks | `ambush`, `monsters` |
| Costumes with stats (Courage / Sneak / Luck) and monster counters, plus upgrades, all as candy **sinks** | `costumes`, `upgrades` |
| 4 house types (Normal, Haunted, Witch Hut, Graveyard) and 30 hand-named houses | `houses` |
| **House reputation v1** (0–100): trust-weighted, time-decayed, capped per visitor; public house log | `reputation` |
| Daily free knocks plus regen, a forgiving **streak** (1 grace day/week), **3 daily missions**, a daily route and a rotating **Hot House** (2× candy) | `energy`, `streak`, `missions` |
| Leaderboards (candy, houses visited, scares survived, Most Notorious houses) and a global **Street Report** feed | `leaderboards`, `feed` |
| **Share cards** for wins *and* funny losses (PNG plus a post to X) | `public/app.js` `showShareCard` |
| Basic anti-bot: knock gesture, minimum knock interval, robotic-cadence detection → trust score, low-trust payout scaling, per-day diminishing candy returns, per-IP rate limit | `checkGesture`, `trust`, `dailyCandy` |
| "Scared too many times" comfort item (Lucky Candle) | `comfort` |
| Scripted first 5 knocks matching the first-30-minutes journey | `TUTORIAL` |

### Seasons are data

Everything seasonal (odds, house types, moods/tells, monsters, costumes, missions, flavor
text) lives in `season/halloween-2026.json`. Zombie November is a new JSON file plus art
(`SEASON=season/zombie-november.json npm start`), not an engineering rewrite.

## Architecture (Season 0 slice)

```
public/          Vanilla JS client (renders state, captures input; no game logic)
server/index.js  HTTP API + static files, no dependencies
server/game.js   Authoritative rules: RNG, odds, pity, mini-games, reputation, trust
server/store.js  JSON-file state store (stand-in for Postgres + Redis)
season/          Season Pack(s)
test/            Rule tests with a deterministic clock and RNG
```

All randomness and timing is **server-authoritative**. The client never decides an
outcome, and scare reactions are measured against the server's own clock.

### Deliberately not built yet (per the doc)

Token, wallets, house deeds/NFTs, player monsters and the Behavior Dial, the marketplace,
crafting, guilds, trading, and any real-world or random-drop prizes. These are Phase 2/3 and
gated on Season 0 retention (D1/D7, share rate). Login is a name-based guest account for
now; passkey or social login is the next step before a public launch.

## Tuning

The design doc expects odds to be retuned 3–5 times. Edit the season JSON and restart.
`npm test` checks that the baseline table still matches the doc (64/36) and that
modifiers stay within the protocol caps.
