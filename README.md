# 🎃 Knock

> Knock on doors. Collect candy. Survive monsters. **90% Tricks. 10% Treats.**

A trick-or-treat game where players explore haunted neighborhoods, knock on doors for
candy, survive scares, and can become the monsters themselves. Houses are ownable
on-chain deeds with a public reputation, and the $BOO token sits underneath the game
instead of in the player's face.

## Run it

```bash
npm start                                   # http://localhost:3000
npm test                                    # rule tests (node:test, no dependencies)
SEASON=season/zombie-november.json npm start # same game, Zombie November season
```

Requires Node 20+. No npm dependencies. State is saved to `data/state.json` (`DATA_FILE`, `PORT` env vars).

> **Devnet.** The "chain" is a simulated ledger inside the server (`server/chain.js`):
> hash-linked blocks plus programs for the token, NFTs, the staking bond, escrow, signed
> claims and anchors. It has the same shape as the Solana programs the game needs, so it
> can be swapped for a real client. $BOO here is test currency, from a once-a-day devnet faucet.

## The world (2D pixel art)

A top-down pixel-art neighborhood in the spirit of Stardew Valley, drawn on a plain
`<canvas>` with no dependencies. Every sprite (11 kid costumes in 4 directions, 10 house
types, the Candy Bank, gatekeepers, fences, trees, lamps, tombstones, ghosts) is drawn in
code in `public/js/pixel/sprites.js`, following the designs and palette of the original
models in `art/reference-models/`. A night lighting pass cuts pools of light from street
lamps, windows, porch lights and the candle in your bucket.

- **Start menu**: character name, a *Connect Solana wallet* button (Phantom / Solflare /
  Backpack, a visual preview only for now), Play, and How to Play.
- **Tutorial**: after Play, new players get an interactive tutorial in the real world
  (walk, knock, knock again, bank your candy, open the menu, meet a gatekeeper), with a
  **Skip tutorial** button on every step. Replay it from Me → Replay tutorial.
- **How to Play**: a one-screen rundown of every feature (`H`, the ❔ button, or the start menu).
- **Controls**: `WASD`/arrows to walk, `Shift` to run, **hold & release `E`** at a door to
  knock (or talk/deposit), `Tab` menu, `H` help. Phones: floating joystick + action button.
- **Neighborhoods**: a town square (Candy Bank, pumpkin fountain) with Hollow Lane to the
  north, Crypt Row to the east and Witchwood Heights to the west. Each has two streets of
  houses. **Fences run exactly along the edges of the walkable area**, so nothing can be
  walked through.
- **Gatekeepers**: Crypt Row and Witchwood Heights are fenced with a locked gate. Their
  Gatekeeper lets you in for free once you reach the level, or for a **one-time candy
  bribe**. Either way it's permanent, and the server checks you're standing at the gate.
- **NPC homes vs. empty lots**: most houses are NPC homes. Dark, boarded-up houses with
  FOR SALE signs are the NFT lots; once bought they light up with the owner's sign.
- **The Candy Bank** is a building in the square. Walk your bucket there and press `E`.
- **Tells are visible**: flickering or flashing windows, a big warm porch light, caramel
  steam from the chimney, a jack-o'-lantern, rustling bushes, claw marks on the door.
- **Anti-teleport**: the server knows where every door, the bank and the gatekeepers are
  (`server/layout.js`, shared with the client) and rejects actions that would need
  faster-than-running travel since the last one.

## Dev build

```bash
npm run dev        # same game + a dev panel (press ` or the red DEV button)
```

The dev panel only exists when the server runs with `DEV=1`. Its `/api/dev/*` endpoints
are not registered otherwise. It lets you skip the grind:

- +10k / +1M candy, fill your bucket, +5k $BOO, 999 knocks, set any level
- become any Scare Actor instantly (stake and bond warm-up skipped, full Fright)
- unlock every neighborhood, costume, monster card or secret house
- **force the next knock** (any outcome, including a Golden Pumpkin jackpot)
- spawn a rival player-monster's ambush or trap at the nearest house, clear your shield
- open the Legendary Mansion, settle owner/monster payouts now, start a new day
- teleport anywhere, turn off the travel-speed check, and replay the tutorial

## The game

### Trick-or-Treaters (everyone)
- **Knock** (press and release the door) using daily free knocks that regenerate.
- **10 outcomes**: candy, big candy, rare candy, monster card, $BOO, legendary
  (with a rate-limited Golden Pumpkin jackpot), secret-house discovery, trick, scare
  mini-game, and monster attack.
- **Bucket vs. bank**: only candy in your bucket is at risk. Walk it to the Candy Bank to
  deposit it (this also resets **Nightfall**, the danger level that rises the longer you stay out).
- **Tells** on every house (flickering lights, claw marks on the gate) hint at its hidden
  daily mood and are honest 75% of the time.
- **Stats** (Courage, Sneak, Luck) come from training (with escalating cost and a cap),
  costumes and boosts. Costumes also counter specific monster types.
- **3 neighborhoods**: Hollow Lane, Crypt Row (level 4, 1.5× candy) and Witchwood Heights
  (level 8, 2× candy), each unlocked with candy.
- **Secret houses** are found by rare knocks. The **Legendary Mansion** opens to everyone
  for one hour a day.
- Daily missions, a forgiving streak, a daily route, a rotating Hot House, and a pity timer
  (rare-or-better within 40 knocks).

### Scare Actors (player monsters)
- Stake **200 $BOO** as a bond for a **Monster License**. The stake is *time-weighted*
  and must settle before the license is active, so a flash-loaned balance can't buy one.
- Pick Ghost (stealth), Zombie (resilient), Vampire (drain) or Witch (traps). Spend
  **Fright**, a regenerating resource, to set **ambushes** or **traps** at any house.
- Victims fight back by reading a clue and choosing a counter (salt, torch, garlic,
  mirror…), with a costume and the option to throw candy as a distraction.
- **Your 60/40 example, redesigned:** the base steal chance is 55%. The right counter makes
  it 35%, the wrong one 60%, and costume and Sneak lower it further (clamped 20–70%).
  Success steals at most 10% of the bag (12% for vampires), never the stash. 10% of the haul
  is paid to the house owner.
  **Failure costs Fright, a candy fine, 5% of unclaimed monster earnings and a stun.**
  The bond itself is slashed only for proven abuse (botting, collusion), never for losing a
  coin flip, which would make it a wager.
- Anti-grief rules: a 20-minute victim shield, the same monster can't hit the same player
  twice in 6h, level-bracket matching, no ambushes in a player's first 10 knocks, and a
  free Lucky Candle for players who are scared too often. Monster and victim on the same
  network → no trigger, and both lose trust.
- **Bounties**: victims put candy on a monster's head, and whoever beats one of its lairs collects.

### Houses
- **10 types**: Normal, Pumpkin Farm, Haunted House, Witch Hut, Zombie House, Graveyard,
  Vampire Castle, Abandoned Mansion, Secret Laboratory and Legendary Mansion (secret, not
  for sale). Each type shifts the odds table within protocol caps.
- **Only empty lots are for sale** (11 across the three neighborhoods, set per season in
  `plots`). NPC homes can be knocked on but never bought.
- **Deeds are NFTs**, bought with $BOO and capped at 3 per wallet, and traded on an escrow
  marketplace (5% fee, half burned).
- **Public stats card**: visits, candy given, players scared, jackpots, monster attacks,
  reputation (0–100). Reputation is trust-weighted, time-decayed, capped per visitor, and
  ignores the owner's own visits. A hash of all house stats is anchored on-chain every day.
- **Behavior Dial** (Generous / Balanced / Haunted): changes take **24h** and are posted to
  the house log and the global feed. Owners *can* turn a beloved house into a trap, but
  everyone gets a warning. This "who do you trust" layer is the social core of the game.
- **Owner revenue comes from real activity, not new buyers**: half of candy entry fees at
  premium houses, a 10% tax on monster hauls at the house, and a daily **Haunt Pool** in
  $BOO. The pool is funded by a share of that day's revenue and split by *square-root* of
  trust-weighted unique visitors, so owning more houses doesn't scale linearly. **Lanterns**
  ($BOO, half burned) add traffic and pool weight.

### Candy (off-chain, non-transferable)
- **Faucets**: knocks, missions, streaks, defended ambushes. Each is throttled by a daily
  soft cap and a hard cap, and scaled by account trust.
- **Sinks**: costumes, boosts (Lucky Lollipop, Night Vision, Monster Repellent), bag/stash
  upgrades, stat training, neighborhood unlocks, entry fees, card crafting, a daily cosmetic
  raffle, candy thrown at monsters, monster fines, and bounties.
- Every faucet and sink is counted. `GET /api/economy` reports the sink ratio and token supply.

### $BOO (optional, never required to play)
- Fixed supply (1B) allocated at genesis: 30% rewards vault, 20% treasury, 15% team,
  15% community, 10% liquidity, 10% early supporters.
- **Uses**: house deeds, lanterns, the Monster License bond, premium costumes (40% burned),
  and marketplace settlement.
- **Rewards are revenue-funded.** Each day, 25% of revenue goes to house owners, 15% to
  monsters (concave, by successful scares) and 20% back to the rewards vault. A small
  bootstrap top-up declines 10% a day.
- Knock rewards are capped (25 $BOO/day), trust-gated, and paid by **server-signed claim
  tickets** that the chain verifies (signature + nonce) before paying from a funded vault.

### Collectibles and real-world prizes
- **12 original monster cards** (our own IP: no Pokémon or other brands). Duplicates craft
  up a rarity, and Epic and Legendary cards can be minted to the wallet as NFTs.
- **Real-world prizes are milestone- and rank-based only**: a full card deck, 5
  legendaries, or a season top-3 finish. They are **never** a random drop, because
  prize + chance + paid entry is the legal test for an illegal lottery in most places.
  Redemption needs an established account (trust ≥ 60) and goes to manual review, where
  shipping, KYC, tax and geo-restrictions are handled.
  *Get gaming and securities counsel before attaching real value to anything.*

### Social
- **11 leaderboards** with novice/regular/veteran divisions: most candy, houses visited,
  monsters defeated, scares survived, legendaries, richest trick-or-treater, players
  scared, candy stolen, richest monster, most notorious monster, plus most valuable,
  famous and notorious houses.
- **Share cards** for wins *and* funny losses, plus a **player card** (role, candy,
  houses, biggest reward, scares, rank, reputation). Both export as PNG or post to X.
- A global **Street Report** feed with jackpots, steals, behavior-change warnings, bounties,
  the Legendary Mansion opening, and deed sales. Players also get personal revenge
  notifications.

### Onboarding
New players get a character and start knocking. No wallet, no token, no fees. The economy
(wallet, $BOO, houses, monsters, market) appears as **Haunted Streets** at level 3, and the
wallet was created silently when the player arrived.

### Seasons
Everything themed lives in a **Season Pack** (`season/*.json`). A pack can `extends`
another and override only what changes. `zombie-november.json` reskins neighborhoods,
monsters, costumes, odds and flavor text in about 40 lines. Each pack's hash is anchored in
the on-chain season registry. Player profiles, deeds, cards and $BOO persist across
seasons; season stats are kept per season.

## Odds: why not 70/15/5/8/2?

Your draft paid out 92% of the time, which contradicts "90% Tricks". Rare candy at 15%
isn't rare, and legendary at 2% is too frequent to stay valuable. The baseline used here:

| Outcome | % |
| --- | --- |
| Candy | 40 |
| Big candy | 10 |
| Rare candy | 7 |
| Monster card | 3 |
| $BOO | 3 |
| Legendary (jackpot ≈ 0.075% overall, max 3/day globally) | 1.5 |
| Secret house | 0.5 |
| Trick (lose 1–3 candy, always funny) | 20 |
| Scare mini-game | 10 |
| Monster attack | 5 |

That's 65% rewards and 35% bad outcomes. Tells, house types, owner dials, neighborhoods and
Nightfall all shift these numbers, within protocol caps.

## Architecture

```
public/js/main.js  Client: start menu, tutorial, HUD, menus, knock/bank/gatekeeper flows
public/js/pixel/   Pixel-art sprites (sprites.js), world renderer (world2d.js), player (actor.js)
public/js/ui/      How to Play and the dev panel
art/               Reference models the pixel art is based on
server/index.js    HTTP API + static files
server/game.js     Wires the modules; views, leaderboards, public API
server/core.js     Players, energy, candy flow, trust, feed
server/knock.js    Odds, outcomes, scares, ambushes, traps
server/houses.js   Neighborhoods, reputation, deeds, dial, owner revenue, daily epoch
server/monsters.js License, Fright, lairs, monster results, bounties
server/economy.js  Shop, training, raffle, cards, prizes, claims, missions
server/chain.js    Simulated chain: token, NFTs, stake, escrow, signed claims, anchors
server/config.js   Season Pack loader (extends + merge)
server/layout.js   World layout (houses, doors, bank, gates, gatekeepers), shared with the client
server/dev.js      Dev-build shortcuts (only with DEV=1)
season/            Season Packs
test/              Rule tests with a deterministic clock and RNG
```

**On-chain**: token balances, house deeds, card NFTs, the monster bond, marketplace
escrow, reward claims, the reputation hash and the season registry. These are ownership and
value, and need public verification.
**Off-chain**: knocks, RNG, candy, mini-games, matchmaking, reputation math and
leaderboards. These happen thousands of times an hour and must be instant and free.
