const TARGET        = 'basi.onl';
const CHARS         = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-/';
const FLIP_MS       = 110;   // duration of one flip in ms
const TILE_STAGGER  = 140;   // ms delay between each tile starting

const board = document.getElementById('board');
const tiles = [];

// ── Build DOM ─────────────────────────────────────────────
TARGET.split('').forEach(ch => {
  const upper    = ch.toUpperCase();
  const isNarrow = ch === '.';

  const tile = document.createElement('div');
  tile.className = 'tile' + (isNarrow ? ' narrow' : '');

  // Static card (always behind, shows resting char)
  const staticCard = document.createElement('div');
  staticCard.className = 'tile-static';
  const staticSpan = document.createElement('span');
  staticSpan.textContent = ' ';
  staticCard.appendChild(staticSpan);

  // Top half — upper portion of current char
  const topHalf = document.createElement('div');
  topHalf.className = 'tile-top';
  const topSpan = document.createElement('span');
  topSpan.textContent = ' ';
  topHalf.appendChild(topSpan);

  // Bottom half — lower portion of next char
  const botHalf = document.createElement('div');
  botHalf.className = 'tile-bottom';
  const botSpan = document.createElement('span');
  botSpan.textContent = ' ';
  botHalf.appendChild(botSpan);

  // Flap
  const flap = document.createElement('div');
  flap.className = 'tile-flap';

  const front = document.createElement('div');
  front.className = 'tile-flap-front';
  const frontSpan = document.createElement('span');
  frontSpan.textContent = ' ';
  front.appendChild(frontSpan);

  const back = document.createElement('div');
  back.className = 'tile-flap-back';
  const backSpan = document.createElement('span');
  backSpan.textContent = ' ';
  back.appendChild(backSpan);

  flap.appendChild(front);
  flap.appendChild(back);

  tile.appendChild(staticCard);
  tile.appendChild(topHalf);
  tile.appendChild(botHalf);
  tile.appendChild(flap);
  board.appendChild(tile);

  tiles.push({
    staticCard, staticSpan,
    topSpan, botSpan,
    flap, frontSpan, backSpan,
    target: upper
  });
});

// ── Flip engine using Web Animations API ─────────────────
function flipTile(t, currentIdx, targetIdx, resolve) {
  const currentChar = CHARS[currentIdx];
  const nextIdx     = (currentIdx + 1) % CHARS.length;
  const nextChar    = CHARS[nextIdx];

  // Set characters
  t.topSpan.textContent    = currentChar;
  t.botSpan.textContent    = nextChar;
  t.frontSpan.textContent  = currentChar;
  t.backSpan.textContent   = nextChar;
  t.staticSpan.textContent = currentChar;

  // Animate flap from 0° → -180° using Web Animations API
  const anim = t.flap.animate(
    [
      { transform: 'rotateX(0deg)'    },
      { transform: 'rotateX(-180deg)' }
    ],
    {
      duration: FLIP_MS,
      easing: 'ease-in-out',
      fill: 'forwards'
    }
  );

  anim.onfinish = () => {
    t.staticSpan.textContent = nextChar;

    if (nextIdx !== targetIdx) {
      // Reset flap instantly and go again
      t.flap.style.transform = 'rotateX(0deg)';
      anim.cancel();
      flipTile(t, nextIdx, targetIdx, resolve);
    } else {
      // Settled
      t.staticSpan.textContent = t.target;
      t.staticCard.classList.add('done');
      t.topSpan.textContent   = t.target;
      t.botSpan.textContent   = t.target;
      t.flap.style.visibility = 'hidden';
      resolve();
    }
  };
}

// ── Kick off each tile with stagger ──────────────────────
tiles.forEach((t, i) => {
  const targetIdx = CHARS.indexOf(t.target) !== -1
    ? CHARS.indexOf(t.target)
    : 0;

  setTimeout(() => {
    new Promise(resolve => flipTile(t, 0, targetIdx, resolve));
  }, i * TILE_STAGGER);
});