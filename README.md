# 🎃 Knock

> Knock on doors. Collect candy. Survive monsters. **90% Tricks. 10% Treats.**

A trick-or-treat game where players explore haunted neighborhoods, knock on doors for
candy, survive scares, and can become the monsters themselves. Houses are ownable
on-chain deeds with a public reputation, and the $BOO token sits underneath the game
instead of in the player's face.

## Run it

```bash
npm start                                   # http://localhost:3000 (simulated chain, no dependencies)
npm install && npm test                     # game rules + on-chain tests (LiteSVM)
npm run start:local                         # real Solana programs, in-process chain
npm run solana:setup && npm run start:solana # Solana devnet (see "Running on real Solana")
SEASON=season/zombie-november.json npm start # same game, Zombie November season
```

Requires Node 20+. `npm start` needs no npm packages; the Solana modes and the tests use
`@solana/web3.js`, `@solana/spl-token` and LiteSVM. State is saved to `data/state.json`
(`data/state-solana.json` on devnet; `DATA_FILE`, `PORT`, `PUBLIC_URL` env vars).

> **Devnet.** The "chain" is a simulated ledger inside the server (`server/chain.js`):
> hash-linked blocks plus programs for the token, NFTs, the staking bond, escrow, signed
> claims and anchors. It has the same shape as the Solana programs the game needs, so it
> can be swapped for a real client. $BOO and SOL here are test currency, from once-a-day devnet faucets.

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
- **Town shops**: the square is lined with shops you walk into: *Spooky Threads*
  (costumes), *Sugar Rush* (boosts and upgrades), *Crypt Cards* (card crafting and minting),
  the *Courage Dojo* (stat training) and the *Raffle Tent* (Town Raffle and player raffles).
  The menu's Shop tab sells the same things.
- **Inventory**: press `I` (or 🎒) for everything you've collected: candy, $BOO, SOL,
  costumes, monster cards and card NFTs, items and boosts, houses, secret-house keys,
  trophies, raffle slots and prizes.
- **Notifications** (Legendary Mansion, raffle draws, secret houses, wins) slide in on the
  right, fade after 15 seconds and can be closed early with ✕.
- **Townsfolk missions**: Mayor Gourd (square), Old Mrs. Hollow (Hollow Lane), Gravedigger
  Mort (Crypt Row) and Hazel the witch (Witchwood) each offer one mission a day. A **!**
  means a new mission; walk up and press `E` to accept. Progress counts from then, and a
  **?** means the reward is ready to collect from them. The Missions tab is a quest log with
  📍 Track. Rewards scale with the neighborhood's candy multiplier.
- **Stats explained**: Courage (+90 ms scare window per point), Sneak (−2% monster steal
  chance per point, fewer ambushes, +5% trap dodge) and Luck (more rare-candy weight) are
  described in the Dojo, the Me tab and How to Play.
- **Settings** (`Esc` or ⚙): zoom, controls hint, replay tutorial, How to Play, the dev
  panel in dev builds, **back to the main menu**, and log out.
- **Tells are visible**: flickering or flashing windows, a big warm porch light, caramel
  steam from the chimney, a jack-o'-lantern, rustling bushes, claw marks on the door.
- **Anti-teleport**: the server knows where every door, the bank and the gatekeepers are
  (`server/layout.js`, shared with the client) and rejects actions that would need
  faster-than-running travel since the last one.

## Solana wallets (sign in with Solana)

Players can connect a real Solana wallet (Phantom, Solflare, Backpack, or anything that
supports the Wallet Standard) on the start menu or in Settings. The wallet signs one free,
plain-text "Sign in with Solana" message (not a transaction). The server checks the ed25519
signature, and the wallet is linked to the character. That wallet can sign back into the same
character on any device, and it's how the game will know who pays when purchases move on-chain.

- The message names the site, the address, the cluster, a one-time nonce and a 5-minute expiry.
  The server only accepts a signature over the exact message it issued, and each nonce works once.
- A wallet belongs to one character. Unlink it in Settings.
- The start menu shows the wallet's real SOL balance, read from the cluster's public RPC.
- `SOLANA_CLUSTER` (default `devnet`) and `SOLANA_RPC` (default `https://api.<cluster>.solana.com`)
  pick the network. Get free devnet SOL at https://faucet.solana.com.
- No npm packages: wallet discovery is in `public/js/wallet.js`, verification in `server/solana.js`.

## Running on real Solana

| Mode | Command | What it is |
|---|---|---|
| Simulated (default) | `npm start` | The built-in simulated chain. No dependencies, no network. |
| Local chain | `npm install` then `npm run start:local` | Real Solana programs running in-process (LiteSVM). Fresh chain every start. Real wallets can sign; the 🪂 button gives test SOL. |
| Devnet | `npm install`, `npm run solana:setup`, then `npm run start:solana` | Real Solana devnet through its public RPC (`SOLANA_RPC` to use your own). |

How value moves (`server/onchain/`):

- **$BOO** is a real Token-2022 token: fixed supply (1B, 0 decimals), with its name and symbol
  stored on the mint. `solana:setup` mints the whole supply into the game vault and removes the mint
  authority, so no more can ever be created.
- **Deeds and minted cards are real NFTs** (Token-2022, supply 1, metadata on the mint, no Metaplex
  needed), minted straight into the owner's linked wallet. If a deed is sold or sent outside the
  game, Knock follows the on-chain holder within 30 seconds.
- **Game balances** (the $BOO and SOL you spend in shops, on deeds and in the market) are backed 1:1
  by the vault. **Deposit**: the server builds the transaction, your wallet signs it, the server
  checks the signed bytes are exactly what it built, adds its fee-payer signature and sends it (you
  pay no network fee). Your balance is credited only after it confirms. **Withdraw**: queued and sent
  by the game; refunded if it can't be sent.
- **Listing a house / raffling a card NFT** that sits in your wallet first moves it into escrow
  (one wallet signature). Buyers and raffle winners get the NFT delivered to their wallet.
- Ledger $BOO burns are mirrored by real burns from the vault. `GET /api/onchain/report` compares
  the vault's on-chain balances with the ledger.
- **Crash-safe sending**: every game-sent transaction's signature is saved before it is sent. After
  a lost confirmation or a restart, the bridge checks the chain before ever sending it again.
- Keys live in `data/solana-keys.json` (git-ignored; back it up, it controls the vault).
  `solana:setup` refuses mainnet unless you set `I_UNDERSTAND_MAINNET=yes`. Don't do that before
  an audit.

### The Knock program (`programs/knock`, Anchor 0.31)

On-chain code for the parts that hold other people's value: the **fee split** (`pay_sol`,
`pay_boo`), **house market escrow** (`list_nft`, `buy_nft`, `cancel_listing`; seller paid and NFT
delivered in one transaction), **raffle escrow** (`raffle_deposit`, `raffle_settle`,
`raffle_refund`) and the **monster bond** (`stake`, `unstake`, time-weighted, and a capped
`slash`). `npm run test:program` runs its unit tests (fee split, stake weighting, rate limits).

It compiles and its tests pass natively, but it has **not yet been built for or deployed to a
Solana cluster**. Building needs the Solana/Anchor toolchain (`anchor build`, or Solana Playground at
beta.solpg.io: paste `programs/knock/src/lib.rs`, build, deploy to devnet, and put the deployed
program ID into `declare_id!`). Until it's deployed and the server is switched over to it, escrow
is held by the game's vault key (the bridge above).

## Dev build

```bash
npm run dev                    # same game + a dev panel (press ` or the red DEV button)
node server/index.js --dev     # the same, without npm
```

On Windows, `set DEV=1 && node server/index.js` also works (the trailing space `set`
leaves in the value is ignored). The start menu shows **DEV BUILD** when it's on.

The dev panel only exists when the server runs with `DEV=1`. Its `/api/dev/*` endpoints
are not registered otherwise. It lets you skip the grind:

- +10k / +1M candy, fill your bucket, +5k $BOO, +10 SOL, 999 knocks, set any level
- become any Scare Actor instantly (stake and bond warm-up skipped, full Fright)
- unlock every neighborhood, costume, monster card or secret house
- **force the next knock** (any outcome, including a Golden Pumpkin jackpot)
- spawn a rival player-monster's ambush or trap at the nearest house, clear your shield
- open the Legendary Mansion (or make its random schedule fire in 3s), settle owner/monster
  payouts now, start a new day
- seed the raffle prize pool, draw the Town Raffle now (with 3 bot entrants), end every
  player raffle now
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
  for 5 minutes at a **random** time every 20–40 minutes. The server picks the next opening
  with its RNG and never sends it to clients, so bots can't camp the door.
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
- **Deeds are NFTs**, bought with **SOL** (0.3–1.5 SOL by house type) and capped at 3 per
  wallet, and resold for SOL on an escrow marketplace (5% fee, routed like every other fee).
- **Public stats card**: visits, candy given, players scared, jackpots, monster attacks,
  reputation (0–100). Reputation is trust-weighted, time-decayed, capped per visitor, and
  ignores the owner's own visits. A hash of all house stats is anchored on-chain every day.
- **Behavior Dial** (Generous / Balanced / Haunted): changes take **24h** and are posted to
  the house log and the global feed. Owners *can* turn a beloved house into a trap, but
  everyone gets a warning. This "who do you trust" layer is the social core of the game.
- **Owner revenue comes from real activity, not new buyers**: **+2 candy for every new
  trusted visitor per day**, half of candy entry fees at premium houses, a 10% tax on
  monster hauls at the house, **a share of 2% of every transaction fee** ($BOO and SOL, split
  evenly per owned house, paid daily to the owner's wallet), and a daily **Haunt Pool** in
  $BOO. The pool is funded by a share of that day's revenue and split by *square-root* of
  trust-weighted unique visitors, so owning more houses doesn't scale linearly. **Lanterns**
  ($BOO, half burned) add traffic and pool weight.

### Candy (off-chain, non-transferable)
- **Faucets**: knocks, missions, streaks, defended ambushes. Each is throttled by a daily
  soft cap and a hard cap, and scaled by account trust.
- **Sinks**: costumes, boosts (Lucky Lollipop, Night Vision, Monster Repellent), bag/stash
  upgrades, stat training, neighborhood unlocks, entry fees, card crafting, raffle slots
  (and the 10% cut of player raffles), candy thrown at monsters, monster fines, and bounties.
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

### Transaction fees
Every $BOO or SOL payment (deeds, lanterns, premium costumes, market sales) carries a
**5% fee**, split by `fees.split` in the Season Pack: **2% to house owners**, **40% to the
raffle prize pool**, **30% burned** ($BOO only) and the rest to the treasury. Splits keep
fractional carry, so small fees still add up exactly. `GET /api/economy` shows the totals.

### Raffles
- **Town Raffle**: a round draws every **5 minutes** (countdown on the left of the screen,
  plus a notification a minute before and when results are in). Slots cost 5 candy, up to
  **100 per player per round**, plus **one free slot a day**. Slots weight the draw, and
  **10 different players** win each round.
- Prizes ($5 / $2 / $1 cash and small fractional-stock amounts) are paid **only from the
  prize pool**, which is funded by transaction fees and valued at the season's `usdRate`.
  A won prize is reserved from the pool and recorded as a **pending redemption**. The winner
  claims it with an 18+ confirmation, region and email, and an admin pays it out by hand.
  If the pool can't cover a prize, or the round has fewer than 3 players, or the winner's
  account isn't established yet (trust ≥ 60), the winner gets candy instead (the first
  winner gets the Moonlit Banshee costume). `raffle.realPrizes: false` turns cash and stock
  prizes off entirely.
- **Player raffles** (the auction house): raffle off $BOO, a monster card or a card NFT. The
  item goes into escrow; you set the slot price (1–500 candy), number of slots (2–100) and
  duration (5–60 min). One random slot wins it; the seller gets the candy minus 10%, which is
  burned. No entries means the item comes back. Max 3 running raffles per player.
- *Legal note*: paid-entry random draws for cash or securities are regulated as lotteries
  or sweepstakes in most places. Putting it on Solana doesn't change that. The free daily
  slot, published odds, 18+ check and manual payouts are the usual sweepstakes guardrails,
  but have gaming counsel review the rules (and use a licensed broker for stock prizes)
  before real money is attached.

### Collectibles and real-world prizes
- **12 original monster cards** (our own IP: no Pokémon or other brands). Duplicates craft
  up a rarity, and Epic and Legendary cards can be minted to the wallet as NFTs.
- **Milestone prizes**: a full card deck, 5 legendaries, or a season top-3 finish earn
  merch prizes (separate from the Town Raffle). Redemption needs an established account (trust ≥ 60) and goes to manual review, where
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
server/economy.js  Shop, training, cards, prizes, claims, faucets, missions
server/raffle.js   Transaction fee router, Town Raffle, prize pool, player raffles
server/solana.js   Sign in with Solana: challenges, ed25519 verification, wallet links
server/onchain/    Real-Solana bridge: connection (RPC or LiteSVM), tokens/NFTs, deposits,
                   withdrawals, escrow, outbox worker, ownership sync, setup
programs/knock/    Anchor program: fee split, market and raffle escrow, monster bond
scripts/           solana-setup.js (devnet keys + $BOO mint)
server/chain.js    Simulated chain: $BOO, SOL, NFTs, stake, escrow, signed claims, anchors
server/config.js   Season Pack loader (extends + merge)
server/layout.js   World layout (houses, doors, bank, gates, gatekeepers), shared with the client
server/dev.js      Dev-build shortcuts (only with DEV=1)
season/            Season Packs
test/              Rule tests (deterministic clock and RNG) and on-chain tests (LiteSVM)
```

**On-chain**: token balances, house deeds, card NFTs, the monster bond, marketplace
escrow, reward claims, the reputation hash and the season registry. These are ownership and
value, and need public verification.
**Off-chain**: knocks, RNG, candy, mini-games, matchmaking, reputation math and
leaderboards. These happen thousands of times an hour and must be instant and free.
