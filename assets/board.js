(function () {
  const TARGET        = 'basi.onl';
  const CHARS         = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-/';
  const FLIP_MS       = 110;
  const TILE_STAGGER  = 140;

  const board = document.getElementById('board');
  if (!board) return; // safety guard

  const tiles = [];

  TARGET.split('').forEach(ch => {
    const upper    = ch.toUpperCase();
    const isNarrow = ch === '.';

    const tile = document.createElement('div');
    tile.className = 'tile' + (isNarrow ? ' narrow' : '');

    const staticCard = document.createElement('div');
    staticCard.className = 'tile-static';
    const staticSpan = document.createElement('span');
    staticSpan.textContent = ' ';
    staticCard.appendChild(staticSpan);

    const topHalf = document.createElement('div');
    topHalf.className = 'tile-top';
    const topSpan = document.createElement('span');
    topSpan.textContent = ' ';
    topHalf.appendChild(topSpan);

    const botHalf = document.createElement('div');
    botHalf.className = 'tile-bottom';
    const botSpan = document.createElement('span');
    botSpan.textContent = ' ';
    botHalf.appendChild(botSpan);

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

  function flipTile(t, currentIdx, targetIdx, resolve) {
    const currentChar = CHARS[currentIdx];
    const nextIdx     = (currentIdx + 1) % CHARS.length;
    const nextChar    = CHARS[nextIdx];

    t.topSpan.textContent    = currentChar;
    t.botSpan.textContent    = nextChar;
    t.frontSpan.textContent  = currentChar;
    t.backSpan.textContent   = nextChar;
    t.staticSpan.textContent = currentChar;

    const anim = t.flap.animate(
      [
        { transform: 'rotateX(0deg)'    },
        { transform: 'rotateX(-180deg)' }
      ],
      { duration: FLIP_MS, easing: 'ease-in-out', fill: 'forwards' }
    );

    anim.onfinish = () => {
      t.staticSpan.textContent = nextChar;
      if (nextIdx !== targetIdx) {
        t.flap.style.transform = 'rotateX(0deg)';
        anim.cancel();
        flipTile(t, nextIdx, targetIdx, resolve);
      } else {
        t.staticSpan.textContent = t.target;
        t.staticCard.classList.add('done');
        t.topSpan.textContent   = t.target;
        t.botSpan.textContent   = t.target;
        t.flap.style.visibility = 'hidden';
        resolve();
      }
    };
  }

  tiles.forEach((t, i) => {
    const targetIdx = CHARS.indexOf(t.target) !== -1 ? CHARS.indexOf(t.target) : 0;
    setTimeout(() => {
      new Promise(resolve => flipTile(t, 0, targetIdx, resolve));
    }, i * TILE_STAGGER);
  });
})();