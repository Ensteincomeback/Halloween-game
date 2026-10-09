// "How to play": a short rundown of every feature, shown from the start menu,
// the Me tab, or with the H key.

export function helpHtml(catalog) {
  const sym = catalog.token.symbol;
  const cards = [
    ['🚶', 'Move & knock', 'Walk with <kbd>WASD</kbd> / arrows (joystick on phones), <kbd>Shift</kbd> to run. Stand at a door and <b>hold &amp; release <kbd>E</kbd></b> to knock. You get free knocks every day, and they refill over time.'],
    ['🎃', 'What\'s behind the door', 'Mostly candy, but also tricks, scares (tap when it jumps out!), monster attacks, rare candy, monster cards, $' + sym + ', legendary loot and even secret houses. "90% Tricks. 10% Treats."'],
    ['🔎', 'Read the clues', 'Every house shows a clue: a warm porch light means generous, flickering lights mean scary, noises in the bushes mean a monster nearby. Clues are honest most of the time.'],
    ['🪣', 'Bucket & Candy Bank', 'Candy goes in your bucket, and monsters can steal from it. Walk to the <b>Candy Bank</b> in the town square to deposit it safely. A bank trip also resets Nightfall.'],
    ['🌙', 'Nightfall', 'The longer you stay out, the darker it gets: more scares and monsters, but bigger candy. Bank to reset.'],
    ['🧟', 'Monsters', 'When a monster jumps you, read its clue and pick the right defence (salt beats ghosts, garlic beats vampires...). Costumes help too. Losing costs some bucket candy, never your bank.'],
    ['💀', 'Gatekeepers', 'Crypt Row and Witchwood Heights are fenced. Their Gatekeepers let you in once you reach their level, or for a <b>one-time candy bribe</b>. Inside, candy is worth more.'],
    ['🏷️', 'Houses for sale', 'Dark houses with FOR SALE signs are empty lots: NFT deeds you buy with <b>SOL</b>. Owners passively earn candy from every new visitor each day and share ' + Math.round(catalog.houseRules.ownerFeeShare * 100) + '% of all $' + sym + ' and SOL transaction fees. They also set the house\'s behavior (posted publicly, 24h delay) and add lanterns.'],
    ['👑', 'Legendary Mansion', 'Appears at a <b>random</b> time every ' + catalog.legendaryRules.minGapMinutes + '-' + catalog.legendaryRules.maxGapMinutes + ' minutes and stays open ' + catalog.legendaryRules.openMinutes + ' minutes. Nobody knows when, so just play and watch for the notification.'],
    ['🎟️', 'Raffles', 'The <b>Town Raffle</b> draws every ' + catalog.raffle.roundMinutes + ' minutes (timer on the left). Buy up to ' + catalog.raffle.maxSlots + ' slots with candy, or use your free daily slot; ' + catalog.raffle.winners + ' winners share prizes funded by transaction fees. At the Raffle Tent you can also raffle off your own $' + sym + ', cards and NFTs.'],
    ['🎒', 'Inventory', 'Press <kbd>I</kbd> (or the 🎒 button) to see everything you have collected: candy, coins, costumes, cards, items, houses, keys, trophies and raffle prizes.'],
    ['😈', 'Be the monster', 'Stake $' + sym + ' for a Monster License and become a Scare Actor: set ambushes and traps at houses using Fright. Fail and you lose Fright and candy, never your stake.'],
    ['📋', 'Townsfolk missions', 'People with a <b>!</b> over their head have a mission for you: walk up and press <kbd>E</kbd>. When it shows <b>?</b>, go back for your reward. Mayor Gourd is in the square; others live in each neighborhood. Your Quest log (menu) tracks them.'],
    ['🛍️', 'Town shops', 'Walk into the shops around the square: <b>Spooky Threads</b> (costumes), <b>Sugar Rush</b> (boosts &amp; upgrades), <b>Crypt Cards</b> (crafting), the <b>Courage Dojo</b> (training) and the <b>Raffle Tent</b>. The menu has the same shop too.'],
    ['🦁', 'Stats', '<b>Courage</b> widens the scare timing window. <b>Sneak</b> lowers monster steal chance and helps you dodge traps. <b>Luck</b> makes rare treats more common. Train them at the Dojo; costumes add more.'],
    ['🔥', 'Daily loop', 'A daily route (⭐), a Hot House (🔥 2× candy) and a forgiving streak bring you back every day.'],
    ['🏆', 'Leaderboards & sharing', 'Climb 11 leaderboards, post bounties on monsters who robbed you, and share cards of your best (and worst) moments.'],
  ];
  return `
    <h2>How to play</h2>
    <p class="muted small">Knock on doors. Collect candy. Survive monsters.</p>
    <div class="help-grid">${cards.map(([icon, title, text]) => `<div class="help-card"><div class="help-icon">${icon}</div><div><b>${title}</b><p>${text}</p></div></div>`).join('')}</div>
    <p class="muted small">Keys: <kbd>E</kbd> act · <kbd>Tab</kbd> menu · <kbd>I</kbd> bag · <kbd>H</kbd> help · <kbd>Esc</kbd> settings${catalog.dev ? ' · <kbd>`</kbd> dev panel' : ''}</p>
    <div class="actions"><button class="btn primary" data-close>Got it</button></div>`;
}
