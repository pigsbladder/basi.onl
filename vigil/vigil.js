/* ── State ───────────────────────────────────────────────────────────────────── */
var bubble       = 'Personal';
var sortOrder    = 'newest';
var lastVisitTs  = 0;   // timestamp of previous page load — items newer than this are "new"

/* ── MusicBrainz ─────────────────────────────────────────────────────────────── */
var MB_BASE    = 'https://musicbrainz.org/ws/2/';
var MB_CACHE   = {};    // keyed by artist name; persisted to localStorage (24h TTL)
var MB_QUEUE   = [];    // rate-limit queue — MB enforces max 1 req/sec
var MB_RUNNING = false;
var liveLoadingTotal = 0;   // total artists queued for this fetch cycle
var liveLoadingDone  = 0;   // artists resolved so far (cached or fetched)

/* ── ESPN / Guardian runtime caches (config is in vigil-config.js) ───────────── */
var ESPN_CACHE       = {};  // keyed by league path, e.g. 'football/nfl'
var ESPN_TEAMS_CACHE = {};  // keyed by league path; persists for the session
var fetchErrors      = {};  // entity name → true when last fetch hit a network error

/* ESPN_ENTITY_ALIASES and TEAM_LEAGUE_MAP are defined in vigil-config.js */

/* Fetch (or serve from cache) the latest news for one ESPN league */
function fetchEspnLeague(path, callback) {
  var cached = ESPN_CACHE[path];
  if (cached && Date.now() - cached.fetchedAt < ESPN_TTL) { callback(cached.articles); return; }
  fetch(ESPN_BASE + path + '/news?limit=50')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var articles = d.articles || [];
      ESPN_CACHE[path] = { articles: articles, fetchedAt: Date.now() };
      callback(articles);
    })
    .catch(function() { callback([]); });
}

/* Fetch all teams for one ESPN league path (session-cached, no TTL needed) */
function fetchEspnTeams(path, callback) {
  if (ESPN_TEAMS_CACHE[path]) { callback(ESPN_TEAMS_CACHE[path]); return; }
  fetch(ESPN_BASE + path + '/teams?limit=100')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var teams = [];
      ((d.sports || [])[0] && (d.sports[0].leagues || [])).forEach(function(l) {
        (l.teams || []).forEach(function(t) {
          if (!t.team) return;
          teams.push({
            id:               t.team.id               || '',
            displayName:      t.team.displayName      || '',
            shortDisplayName: t.team.shortDisplayName || '',
            location:         t.team.location         || '',
            name:             t.team.name             || '',
            abbreviation:     t.team.abbreviation     || '',
            league:           ESPN_LEAGUE_NAMES[path] || path
          });
        });
      });
      ESPN_TEAMS_CACHE[path] = teams;
      callback(teams);
    })
    .catch(function() {
      ESPN_TEAMS_CACHE[path] = []; // don't retry on failure
      callback([]);
    });
}

/* Search for ESPN teams using local TEAM_LEAGUE_MAP + ESPN_LEAGUE_NAMES lookups.
   The ESPN /teams endpoint blocks browser requests (CORS), so we match against
   the static config instead — no network call needed for search. */
function searchEspnTeams(query, callback) {
  var q     = query.toLowerCase().replace(/\b(f\.?c\.?|a\.?f\.?c\.?|s\.?c\.?)\b/gi, '').replace(/\s+/g, ' ').trim();
  var words = q.split(/\s+/).filter(Boolean);
  if (!words.length) { callback([]); return; }

  var seen = {}, out = [];

  /* Score every key in TEAM_LEAGUE_MAP by how many query words it contains */
  var scored = [];
  for (var key in TEAM_LEAGUE_MAP) {
    var hits = words.filter(function(w) { return key.indexOf(w) !== -1; }).length;
    if (hits > 0) scored.push({ key: key, hits: hits, league: TEAM_LEAGUE_MAP[key] });
  }

  /* Sort best match first, then by key length (prefer full names over aliases) */
  scored.sort(function(a, b) { return b.hits - a.hits || a.key.length - b.key.length; });

  /* Deduplicate: keep only the best-scoring entry per unique league+name combo */
  var leagueSeen = {};
  scored.forEach(function(r) {
    if (out.length >= 5) return;
    var leagueName  = ESPN_LEAGUE_NAMES[r.league] || r.league;
    var displayName = r.key.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    /* Use a dedup key of league + first word of key to group aliases */
    var firstWord   = r.key.split(' ')[0];
    var dedupeKey   = r.league + '|' + firstWord;
    if (!leagueSeen[dedupeKey]) {
      leagueSeen[dedupeKey] = true;
      out.push({ name: displayName, meta: leagueName, verified: true });
    }
  });

  callback(out);
}

/* Search the Guardian tags API for verified entity names.
   Falls back gracefully — network errors just yield an empty array. */
function searchGuardianEntities(query, cat, callback) {
  var section = GUARDIAN_SECTIONS[cat] || '';
  fetch('https://content.guardianapis.com/tags?q=' + encodeURIComponent(query) + '&api-key=test&page-size=6')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      var results    = (d.response && d.response.results) || [];
      var candidates = [];
      results.forEach(function(tag) {
        /* When we know the section, skip tags from completely unrelated sections */
        if (section && tag.sectionId && tag.sectionId !== section &&
            tag.type !== 'contributor') return;
        var typeLbl = { contributor: 'Person', keyword: 'Topic', series: 'Series', blog: 'Blog' }[tag.type] || tag.type;
        var meta    = typeLbl + (tag.sectionName ? ' · ' + tag.sectionName : '');
        candidates.push({ name: tag.webTitle, meta: meta, verified: true });
      });
      callback(candidates);
    })
    .catch(function() { callback([]); });
}

/* Build the list of terms to match for an entity name.
   - Checks ESPN_ENTITY_ALIASES first (explicit override).
   - For multi-word entities: requires ALL words (AND), preventing
     "united" alone matching unrelated United States articles etc.
   - For single-word short names (≤4 chars, e.g. "PSG"): uses alias
     lookup only — bare 3-letter strings are too noisy to match raw.
   Returns an array of strings; ALL must appear in the article text. */
/* Build match terms for an entity name.
   Checks ESPN_ENTITY_ALIASES first; falls back to words > 3 chars (AND logic).
   Returns array of strings (all must match), or null to skip ESPN entirely. */
function espnMatchTerms(ent) {
  var key = ent.trim().toLowerCase();
  if (ESPN_ENTITY_ALIASES[key]) return ESPN_ENTITY_ALIASES[key];
  var words = key.split(/\s+/).filter(function(w) { return w.length > 3; });
  if (words.length === 0) return null;
  return words;
}

/* Relevance test: headline-first.
   ALL match terms must appear in the headline, OR appear 2+ times combined.
   This drops roundup articles where a team gets one passing mention. */
function espnArticleRelevant(article, matchTerms) {
  var headline = (article.headline || '').toLowerCase();
  var combined = headline + ' ' + (article.description || '').toLowerCase();
  return matchTerms.every(function(term) {
    if (headline.indexOf(term) !== -1) return true; // headline hit = high confidence
    var count = 0, pos = 0;
    while ((pos = combined.indexOf(term, pos)) !== -1) { count++; pos += term.length; }
    return count >= 2; // body-only: require 2+ mentions
  });
}

/* Guardian headline relevance gate.
   Returns true if the entity's significant words appear in the headline.
   Prevents Guardian returning County Cricket for "Oklahoma City Thunder" etc. */
function guardianIsRelevant(headline, ent) {
  var h = (headline || '').toLowerCase();
  var entLower = ent.toLowerCase();
  if (h.indexOf(entLower) !== -1) return true; // full entity name in headline
  var STOPS = ['the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'will', 'been', 'into'];
  var sigWords = entLower.split(/\s+/).filter(function(w) {
    return w.length > 3 && STOPS.indexOf(w) === -1;
  });
  if (!sigWords.length) return true; // nothing to gate on, let it through
  return sigWords.some(function(w) { return h.indexOf(w) !== -1; });
}

/* Search pinned league (or all leagues) for articles matching an entity */
function loadEspnForEntity(ent, cat, cb) {
  var matchTerms = espnMatchTerms(ent);
  if (!matchTerms || matchTerms.length === 0) { cb([]); return; }

  var pinnedLeague = TEAM_LEAGUE_MAP[ent.trim().toLowerCase()];

  function guardianFallback() {
    var apiUrl = GUARDIAN_API + encodeURIComponent(ent) + '&section=sport';
    fetch(apiUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.response || data.response.status !== 'ok') { cb([]); return; }
        cb(parseGuardianJson(data.response.results, cat, ent));
      })
      .catch(function() { cb(null); }); // null signals network error to caller
  }

  function leagueWideSearch(leagues) {
    var all = [], done = 0;
    leagues.forEach(function(path) {
      fetchEspnLeague(path, function(articles) {
        articles.forEach(function(a) {
          if (espnArticleRelevant(a, matchTerms)) all.push(parseEspnArticle(a, cat, ent));
        });
        if (++done === leagues.length) {
          if (all.length > 0) cb(all.slice(0, GN_MAX)); else guardianFallback();
        }
      });
    });
  }

  /* When the league is pinned, search just that one league feed instead of all 9.
     (The /teams?team=ID endpoint is CORS-blocked so we filter the league feed.) */
  if (pinnedLeague) {
    leagueWideSearch([pinnedLeague]);
  } else {
    leagueWideSearch(ESPN_LEAGUES);
  }
}

function parseEspnArticle(a, cat, ent) {
  var link  = (a.links && a.links.web && a.links.web.href) || '';
  var ts    = a.published ? new Date(a.published).getTime() : 0;
  var id    = 'espn_' + simpleHash(link || a.headline || String(a.id) || '');
  return {
    id:        id,
    cat:       cat,
    ent:       ent,
    title:     a.headline    || '',
    desc:      a.description || '',
    time:      formatRelDateFromTs(ts),
    ts:        ts,
    dismissed: liveDismissed.indexOf(id) !== -1,
    url:       link,
    source:    'espn',
    stale:     !!(ts && (Date.now() - ts) > 7 * 86400000)
  };
}

/* GUARDIAN_API, GUARDIAN_SECTIONS, CAT_QUERY_HINTS defined in vigil-config.js */
var GN_CACHE     = {};   // keyed by entity name; 30-min TTL
var GN_MAX       = 5;    // max articles surfaced per entity
var gnItems      = [];   // live feed items from Google News
var gnLoading    = false;

/* Stable numeric hash of a string — used for GN item IDs (avoids btoa issues) */
function simpleHash(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) { h = Math.imul(31, h) + str.charCodeAt(i) | 0; }
  return Math.abs(h).toString(36);
}

function loadGnCache() {
  var stored = localStorage.getItem('vigil_gn_cache');
  if (!stored) return;
  try {
    var parsed   = JSON.parse(stored);
    var now      = Date.now();
    var HALF_HR  = 1800000;
    for (var key in parsed) {
      if (now - parsed[key].fetchedAt < HALF_HR) GN_CACHE[key] = parsed[key];
    }
  } catch(e) {}
}

function saveGnCache() {
  localStorage.setItem('vigil_gn_cache', JSON.stringify(GN_CACHE));
}

/* Relative time from a millisecond timestamp (for GN items) */
function formatRelDateFromTs(ts) {
  if (!ts) return '';
  var diff = Date.now() - ts;
  var hrs  = Math.floor(diff / 3600000);
  var days = Math.floor(diff / 86400000);
  if (hrs  < 1)  return 'Just now';
  if (hrs  < 24) return hrs  + 'h ago';
  if (days < 7)  return days + 'd ago';
  if (days < 30) return Math.floor(days / 7)  + 'w ago';
  if (days < 365)return Math.floor(days / 30) + 'mo ago';
  return Math.floor(days / 365) + 'yr ago';
}

/* Parse Guardian API response → array of Vigil feed items for a given entity.
   Applies guardianIsRelevant() as a headline gate before accepting a result. */
function parseGuardianJson(results, cat, ent) {
  var out = [];
  (results || []).forEach(function(item) {
    var title   = item.webTitle              || '';
    var link    = item.webUrl                || '';
    var pubDate = item.webPublicationDate    || '';
    var section = item.sectionName           || '';
    var desc    = (item.fields && item.fields.trailText) || '';

    if (!title) return;
    /* Headline gate — drop articles where entity terms don't appear in the title */
    if (!guardianIsRelevant(title, ent)) return;

    /* Strip any HTML from trailText */
    var tmp = document.createElement('div');
    tmp.innerHTML = desc;
    var cleanDesc = (tmp.textContent || tmp.innerText || '').replace(/\s+/g, ' ').trim();

    var ts    = pubDate ? new Date(pubDate).getTime() : 0;
    var stale = ts && (Date.now() - ts) > 7 * 86400000; // > 7 days
    var id    = 'gn_' + simpleHash(link || title);

    out.push({
      id:        id,
      cat:       cat,
      ent:       ent,
      title:     title,
      desc:      section ? section + (cleanDesc ? ' — ' + cleanDesc.slice(0, 150) : '') : cleanDesc.slice(0, 180),
      time:      formatRelDateFromTs(ts),
      ts:        ts,
      dismissed: liveDismissed.indexOf(id) !== -1,
      url:       link,
      source:    'guardian', // was 'google-news' — renamed to reflect actual source
      stale:     !!stale
    });
  });
  return out.slice(0, GN_MAX);
}

/* Fetch Google News RSS for every non-Music interest in the current bubble */
function loadGoogleNewsFeed() {
  fetchErrors = {}; // reset errors on each refresh cycle
  var toFetch = [];
  var data    = interests[bubble] || {};
  for (var cat in data) {
    if (cat === 'Music') continue; // MB handles Music
    var ents = data[cat] || [];
    for (var i = 0; i < ents.length; i++) toFetch.push({ cat: cat, ent: ents[i] });
  }

  if (!toFetch.length) { gnItems = []; mergeAndRender(); return; }

  gnLoading = true;
  gnItems   = [];
  var remaining = toFetch.length;

  toFetch.forEach(function(entry) {
    /* null items signals a network error; empty array means no results */
    function onDone(items) {
      if (items === null) {
        fetchErrors[entry.ent] = true;
        items = [];
      } else {
        delete fetchErrors[entry.ent];
      }
      gnItems = gnItems.concat(items);
      if (--remaining <= 0) { gnLoading = false; saveGnCache(); mergeAndRender(); }
    }

    /* Sports → ESPN (league news filtered by entity name) */
    if (entry.cat === 'Sports') {
      loadEspnForEntity(entry.ent, entry.cat, onDone);
      return;
    }

    /* All other categories → Guardian API */
    /* Cache hit — instant */
    if (GN_CACHE[entry.ent]) {
      onDone(GN_CACHE[entry.ent].items.map(function(item) {
        return Object.assign({}, item, { dismissed: liveDismissed.indexOf(String(item.id)) !== -1 });
      }));
      return;
    }
    /* Fetch directly from Guardian API — no proxy needed, full CORS support */
    var hint    = CAT_QUERY_HINTS[entry.cat] || '';
    var section = GUARDIAN_SECTIONS[entry.cat] ? '&section=' + GUARDIAN_SECTIONS[entry.cat] : '';
    var apiUrl  = GUARDIAN_API + encodeURIComponent(entry.ent + hint) + section;
    fetch(apiUrl)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data || !data.response || data.response.status !== 'ok') { onDone([]); return; }
        var items = parseGuardianJson(data.response.results, entry.cat, entry.ent);
        GN_CACHE[entry.ent] = { items: items, fetchedAt: Date.now() };
        onDone(items);
      })
      .catch(function() { onDone(null); });
  });
}

/* Refresh news for a single entity without re-fetching everything else */
function refreshEntity(entName, cat) {
  var rfBtn = document.querySelector('.tag-rf[data-ent="' + CSS.escape(entName) + '"]');
  if (rfBtn) rfBtn.classList.add('spinning');

  function stopSpinner() {
    var btn = document.querySelector('.tag-rf[data-ent="' + CSS.escape(entName) + '"]');
    if (btn) btn.classList.remove('spinning');
  }

  if (cat === 'Music') {
    delete MB_CACHE[entName];
    loadMusicBrainzFeed(); // other artists are cache hits; only this one re-fetches
    return;               // spinner clears when renderSidebar fires after buildMbItems
  }

  delete GN_CACHE[entName];
  delete fetchErrors[entName];
  if (cat === 'Sports') {
    var pinnedLeague = TEAM_LEAGUE_MAP[(entName || '').trim().toLowerCase()];
    if (pinnedLeague) delete ESPN_CACHE[pinnedLeague];
  }

  function onDone(items) {
    stopSpinner();
    if (items === null) { fetchErrors[entName] = true; items = []; }
    else delete fetchErrors[entName];
    gnItems = gnItems.filter(function(i) { return i.ent !== entName; }).concat(items);
    saveGnCache();
    mergeAndRender();
    renderSidebar();
  }

  if (cat === 'Sports') { loadEspnForEntity(entName, cat, onDone); return; }

  var hint    = CAT_QUERY_HINTS[cat] || '';
  var section = GUARDIAN_SECTIONS[cat] ? '&section=' + GUARDIAN_SECTIONS[cat] : '';
  var apiUrl  = GUARDIAN_API + encodeURIComponent(entName + hint) + section;
  fetch(apiUrl)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data || !data.response || data.response.status !== 'ok') { onDone([]); return; }
      var items = parseGuardianJson(data.response.results, cat, entName);
      GN_CACHE[entName] = { items: items, fetchedAt: Date.now() };
      onDone(items);
    })
    .catch(function() { onDone(null); });
}

/* Merge MB + GN results into liveItems, then re-render */
function mergeAndRender() {
  liveItems = mbItems.concat(gnItems);
  renderFeed();
}

/* Simple loading banner for GN (no progress bar — fetches are parallel & fast) */
function buildGnLoader() {
  var wrap = document.createElement('div');
  wrap.className = 'feed-loader'; wrap.id = 'vigil-gn-loader';
  var txt = document.createElement('span');
  txt.className = 'fl-text'; txt.textContent = 'Fetching latest news…';
  wrap.appendChild(txt);
  return wrap;
}

/* Push a function onto the rate-limit queue and start draining if idle */
function mbEnqueue(fn) {
  MB_QUEUE.push(fn);
  if (!MB_RUNNING) mbDequeue();
}

/* Drain one item, then schedule the next after 1.1 s */
function mbDequeue() {
  if (!MB_QUEUE.length) { MB_RUNNING = false; return; }
  MB_RUNNING = true;
  var fn = MB_QUEUE.shift();
  fn();
  setTimeout(mbDequeue, 1100);
}

/* Enqueue a fetch call; invokes callback(err, data) when done */
function mbFetch(path, callback) {
  mbEnqueue(function() {
    fetch(MB_BASE + path)
      .then(function(r) { return r.json(); })
      .then(function(d) { callback(null, d); })
      .catch(function(e) { callback(e, null); });
  });
}

/* Load MB cache from localStorage, drop stale entries (> 24 h old) */
function loadMbCache() {
  var stored = localStorage.getItem('vigil_mb_cache');
  if (!stored) return;
  try {
    var parsed  = JSON.parse(stored);
    var now     = Date.now();
    var ONE_DAY = 86400000;
    for (var key in parsed) {
      if (now - parsed[key].fetchedAt < ONE_DAY) MB_CACHE[key] = parsed[key];
    }
  } catch(e) {}
}

function saveMbCache() {
  localStorage.setItem('vigil_mb_cache', JSON.stringify(MB_CACHE));
}

/* Relative time from a YYYY-MM-DD (or partial) date string */
function formatRelDate(dateStr) {
  if (!dateStr) return '';
  var p    = dateStr.split('-');
  var d    = new Date(+p[0], p[1] ? +p[1]-1 : 0, p[2] ? +p[2] : 1);
  var diff = Math.floor((Date.now() - d) / 86400000);
  if (diff < 1)   return 'Today';
  if (diff < 7)   return diff + 'd ago';
  if (diff < 30)  return Math.floor(diff/7) + 'w ago';
  if (diff < 365) return Math.floor(diff/30) + 'mo ago';
  var yrs = Math.floor(diff/365);
  return yrs + 'yr ago';
}

/* Human-readable date: '2021-10-29' → 'Oct 29, 2021' */
function formatFullDate(dateStr) {
  if (!dateStr) return '';
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var p = dateStr.split('-');
  var out = p[0];
  if (p[1]) out = months[+p[1]-1] + (p[2] ? ' ' + +p[2] + ', ' : ' ') + p[0];
  return out;
}

/* Parse a YYYY-MM-DD (or partial) date string → millisecond timestamp */
function parseDateToTs(dateStr) {
  if (!dateStr) return 0;
  var p = dateStr.split('-');
  return new Date(+p[0], p[1] ? +p[1]-1 : 0, p[2] ? +p[2] : 1).getTime();
}

/* true if dateStr is older than `days` days */
function isOlderThan(dateStr, days) {
  if (!dateStr) return true;
  var p = dateStr.split('-');
  var d = new Date(+p[0], p[1] ? +p[1]-1 : 0, p[2] ? +p[2] : 1);
  return (Date.now() - d) > days * 86400000;
}

/* Fetch recent releases (+ official URL) for every Music interest in the current bubble */
function loadMusicBrainzFeed() {
  var artists = (interests[bubble] && interests[bubble]['Music'])
    ? interests[bubble]['Music'] : [];

  if (!artists.length) { mbItems = []; mergeAndRender(); return; }

  liveLoading = true;
  liveLoadingTotal = artists.length;
  liveLoadingDone  = 0;
  renderFeed();

  var remaining = artists.length;
  var results   = {};

  function onArtistDone(artist, releases) {
    results[artist] = releases || [];
    remaining--;
    liveLoadingDone++;
    updateFeedLoader();   // tick the progress bar without a full re-render
    if (remaining <= 0) { liveLoading = false; buildMbItems(results); }
  }

  /* Step 3: releases — called after we have the MBID (and optionally the official URL) */
  function fetchReleases(artist, mbid, officialUrl) {
    /* Auto-populate interestUrls only if the user hasn't set one manually */
    if (officialUrl && !interestUrls[artist]) {
      interestUrls[artist] = officialUrl;
      saveUrlState();
    }
    mbFetch(
      'release-group?artist=' + mbid + '&type=album%7Csingle%7Cep&limit=100&fmt=json',
      function(err, rdata) {
        var releases = (!err && rdata && rdata['release-groups']) ? rdata['release-groups'] : [];
        MB_CACHE[artist] = {
          mbid: mbid, releases: releases,
          officialUrl: officialUrl || null,
          fetchedAt: Date.now()
        };
        saveMbCache();
        onArtistDone(artist, releases);
      }
    );
  }

  for (var i = 0; i < artists.length; i++) {
    (function(artist) {
      /* Cache hit — instant, no HTTP.
         If 'officialUrl' key is absent the entry is old-format (pre url-rels);
         delete it so we re-fetch and pick up the homepage. */
      if (MB_CACHE[artist]) {
        if (!('officialUrl' in MB_CACHE[artist])) {
          delete MB_CACHE[artist]; // stale format — fall through to re-fetch
        } else {
          if (MB_CACHE[artist].officialUrl && !interestUrls[artist]) {
            interestUrls[artist] = MB_CACHE[artist].officialUrl;
            saveUrlState();
          }
          onArtistDone(artist, MB_CACHE[artist].releases);
          return;
        }
      }

      /* Step 1: resolve artist name → MBID */
      mbFetch(
        'artist/?query=artist:' + encodeURIComponent('"' + artist + '"') + '&fmt=json&limit=3',
        function(err, data) {
          if (err || !data || !data.artists || !data.artists.length) {
            onArtistDone(artist, null); return;
          }
          var mbid = data.artists[0].id;

          /* Step 2: fetch official homepage URL via url-rels
             Skip if the user has already set a URL manually for this artist */
          if (interestUrls[artist]) {
            fetchReleases(artist, mbid, null);
          } else {
            mbFetch('artist/' + mbid + '?inc=url-rels&fmt=json', function(err2, aData) {
              var officialUrl = null;
              if (!err2 && aData && aData.relations) {
                for (var r = 0; r < aData.relations.length; r++) {
                  if (aData.relations[r].type === 'official homepage') {
                    officialUrl = aData.relations[r].url && aData.relations[r].url.resource;
                    break;
                  }
                }
              }
              fetchReleases(artist, mbid, officialUrl);
            });
          }
        }
      );
    })(artists[i]);
  }
}

/* ── Feed loader helpers ──────────────────────────────────────────────────────── */

/* Update only the progress bar & count text — no full re-render needed */
function updateFeedLoader() {
  var el = document.getElementById('vigil-feed-loader');
  if (!el) return;
  var pct  = liveLoadingTotal ? Math.round((liveLoadingDone / liveLoadingTotal) * 100) : 0;
  var fill = el.querySelector('.fl-bar-fill');
  if (fill) fill.style.width = pct + '%';
  var cnt  = el.querySelector('.fl-count');
  if (cnt)  cnt.textContent  = liveLoadingDone + ' / ' + liveLoadingTotal;
}

/* Build the loading banner (progress bar + count) */
function buildFeedLoader() {
  var wrap = document.createElement('div');
  wrap.className = 'feed-loader';
  wrap.id        = 'vigil-feed-loader';

  var hdr = document.createElement('div');
  hdr.className = 'fl-header';

  var txt = document.createElement('span');
  txt.className   = 'fl-text';
  txt.textContent = 'Pulling feed — please wait';

  var cnt = document.createElement('span');
  cnt.className   = 'fl-count';
  cnt.textContent = liveLoadingDone + ' / ' + liveLoadingTotal;

  hdr.appendChild(txt);
  hdr.appendChild(cnt);

  var barWrap = document.createElement('div');
  barWrap.className = 'fl-bar';

  var barFill = document.createElement('div');
  barFill.className = 'fl-bar-fill';
  var pct = liveLoadingTotal ? Math.round((liveLoadingDone / liveLoadingTotal) * 100) : 0;
  barFill.style.width = pct + '%';

  barWrap.appendChild(barFill);
  wrap.appendChild(hdr);
  wrap.appendChild(barWrap);
  return wrap;
}

/* Build an animated skeleton placeholder card */
function makeSkeletonCard(delayMs) {
  var el = document.createElement('div');
  el.className = 'skeleton-card';
  if (delayMs) el.style.animationDelay = delayMs + 'ms';

  var body = document.createElement('div');
  body.className = 'sk-body';

  // three lines: meta / title / desc — varying widths for a natural look
  var widths = ['28%', '62%', '42%'];
  for (var i = 0; i < widths.length; i++) {
    var line = document.createElement('div');
    line.className = 'sk-line';
    line.style.width = widths[i];
    body.appendChild(line);
  }

  // right-side control placeholder
  var ctrl = document.createElement('div');
  ctrl.className = 'sk-ctrl';

  el.appendChild(body);
  el.appendChild(ctrl);
  return el;
}

/* Convert raw MusicBrainz release groups → Vigil feed items */
function buildMbItems(results) {
  var items   = [];
  var artists = Object.keys(results);

  for (var i = 0; i < artists.length; i++) {
    var artist   = artists[i];
    var releases = (results[artist] || []).filter(function(r) {
      return r['first-release-date']; // skip releases with no date
    });

    /* Sort descending by date, take the single most recent release per artist */
    releases.sort(function(a, b) {
      return b['first-release-date'].localeCompare(a['first-release-date']);
    });
    releases = releases.slice(0, 1);

    for (var j = 0; j < releases.length; j++) {
      var r   = releases[j];
      var id  = 'mb_' + r.id;
      if (liveDismissed.indexOf(id) !== -1) continue;

      var dateStr = r['first-release-date'];
      var relTime = formatRelDate(dateStr);
      var fullDate = formatFullDate(dateStr);

      /* Build type string: 'Album', 'Single', 'EP', 'Live Album', etc. */
      var primaryType     = r['primary-type'] || 'Release';
      var secondaryTypes  = r['secondary-types'] || [];
      var typeStr         = secondaryTypes.length
        ? secondaryTypes.join('/') + ' ' + primaryType
        : primaryType;

      var stale = isOlderThan(dateStr, 365); // > 1 yr old → dashed border

      items.push({
        id:        id,
        cat:       'Music',
        ent:       artist,
        title:     r.title,
        desc:      typeStr + ' · Released ' + fullDate,
        time:      relTime,
        ts:        parseDateToTs(dateStr),
        dismissed: false,
        url:       'https://musicbrainz.org/release-group/' + r.id,
        source:    'musicbrainz',
        stale:     stale
      });
    }
  }

  mbItems = items;
  mergeAndRender();
  renderSidebar(); // clears any per-entity refresh spinners
}

/* ── Live item state (MusicBrainz + Google News + future sources) ────────────── */
var mbItems       = [];   // feed cards from MusicBrainz
var liveItems     = [];   // merged mbItems + gnItems — the rendered live feed
var liveLoading   = false;
var liveDismissed = [];   // string IDs of dismissed live items
var interestUrls  = {};   // { 'Mastodon': 'https://mastodonrocks.com', ... }
var interestSport = {};   // { 'Manchester United FC': 'Soccer', 'OKC Thunder': 'Basketball', ... }

function saveLiveState() {
  localStorage.setItem('vigil_live_dismissed', JSON.stringify(liveDismissed));
}

function saveUrlState() {
  localStorage.setItem('vigil_interest_urls', JSON.stringify(interestUrls));
}

function saveSportState() {
  localStorage.setItem('vigil_interest_sport', JSON.stringify(interestSport));
}

/* ── Spaces (user-defined tabs) ──────────────────────────────────────────────── */
var spaces         = ['Personal'];  // ordered list of user-defined space names
var MAX_FREE_SPACES = 1;            // free tier: 1 space; paid: up to 10
var isPaid         = false;         // toggled from localStorage (vigil_paid=1)

var interests = {
  Personal: {}
};

/* Universal category list — any space can use any category */
var UNIVERSAL_CATS = ['Music','Sports','Film & TV','Gaming','Technology','Books','Podcasts','Watches','Design','Accessibility','Development','Research','Tools','Other'];

/* ── Category colours ────────────────────────────────────────────────────────── */
/* CAT_COLORS, SPORT_ICONS, SVG defined in vigil-config.js */

/* ── Mock feed data — starts empty; real data comes from live sources ────────── */
var feed = {
  Personal: []
};

/* ── Persistence ─────────────────────────────────────────────────────────────── */
function saveState() {
  var dismissed = {};
  for (var b in feed) {
    dismissed[b] = [];
    for (var i = 0; i < feed[b].length; i++) {
      if (feed[b][i].dismissed) dismissed[b].push(feed[b][i].id);
    }
  }
  localStorage.setItem('vigil_spaces',    JSON.stringify(spaces));
  localStorage.setItem('vigil_interests', JSON.stringify(interests));
  localStorage.setItem('vigil_dismissed', JSON.stringify(dismissed));
  localStorage.setItem('vigil_tab',       bubble);
}

function loadState() {
  var savedSpaces       = localStorage.getItem('vigil_spaces');
  var savedInterests    = localStorage.getItem('vigil_interests');
  var savedDismissed    = localStorage.getItem('vigil_dismissed');
  var savedTab          = localStorage.getItem('vigil_tab');
  var savedLiveDismissed = localStorage.getItem('vigil_live_dismissed');

  /* Paid status — flip via DevTools: localStorage.setItem('vigil_paid','1') */
  isPaid = localStorage.getItem('vigil_paid') === '1';

  if (savedSpaces) {
    try {
      var sp = JSON.parse(savedSpaces);
      if (Array.isArray(sp) && sp.length) spaces = sp;
    } catch(e) {}
  }

  if (savedInterests) {
    try {
      var si = JSON.parse(savedInterests);
      /* Migrate old lowercase keys → capitalised (one-time, removes legacy data) */
      if (si.personal && !si.Personal) { si.Personal = si.personal; delete si.personal; }
      if (si.work     && !si.Work)     { si.Work     = si.work;     delete si.work;     }
      interests = si;
    } catch(e) {}
  }

  /* Ensure every space has an entry in interests */
  for (var s = 0; s < spaces.length; s++) {
    if (!interests[spaces[s]]) interests[spaces[s]] = {};
  }

  if (savedDismissed) {
    try {
      var dismissed = JSON.parse(savedDismissed);
      /* Migrate old lowercase dismissed keys */
      if (dismissed.personal && !dismissed.Personal) { dismissed.Personal = dismissed.personal; delete dismissed.personal; }
      if (dismissed.work     && !dismissed.Work)     { dismissed.Work     = dismissed.work;     delete dismissed.work;     }
      for (var b in dismissed) {
        if (!feed[b]) continue;
        for (var i = 0; i < dismissed[b].length; i++) {
          var id = dismissed[b][i];
          for (var j = 0; j < feed[b].length; j++) {
            if (feed[b][j].id === id) { feed[b][j].dismissed = true; break; }
          }
        }
      }
    } catch(e) {}
  }

  /* Restore active tab — fall back to first space if saved tab no longer exists */
  if (savedTab && spaces.indexOf(savedTab) > -1) {
    bubble = savedTab;
  } else {
    /* Legacy: old keys were 'personal'/'work', map to new names */
    if (savedTab === 'personal' && spaces.indexOf('Personal') > -1) bubble = 'Personal';
    else if (savedTab === 'work' && spaces.indexOf('Work') > -1)    bubble = 'Work';
    else                                                             bubble = spaces[0];
  }

  if (savedLiveDismissed) {
    try { liveDismissed = JSON.parse(savedLiveDismissed); } catch(e) {}
  }
  var savedUrls = localStorage.getItem('vigil_interest_urls');
  if (savedUrls) {
    try { interestUrls = JSON.parse(savedUrls); } catch(e) {}
  }
  var savedSport = localStorage.getItem('vigil_interest_sport');
  if (savedSport) {
    try { interestSport = JSON.parse(savedSport); } catch(e) {}
  }
  loadMbCache(); // restore MusicBrainz cache (drops entries > 24 h old)
  loadGnCache(); // restore Google News cache (drops entries > 30 min old)

  /* Read/unread: record when we last opened the app so new items can be flagged */
  var savedLastVisit = localStorage.getItem('vigil_last_visit');
  lastVisitTs = savedLastVisit ? parseInt(savedLastVisit, 10) : 0;
  localStorage.setItem('vigil_last_visit', String(Date.now()));
}

/* ── Active category (category tab filter) ───────────────────────────────────── */
var activeCat  = null;   // null = "All" — show every category
var activeEnt  = null;   // null = all entities; string = filter feed to one interest
var lastBubble = null;   // tracks bubble switches so we can reset activeCat

/* ── Render ──────────────────────────────────────────────────────────────────── */
function render() {
  /* Reset category filter when switching Spaces */
  if (lastBubble !== bubble) { activeCat = null; activeEnt = null; lastBubble = bubble; }
  renderTabs();
  renderCatTabs();
  renderSidebar();
  renderFeed();
  updateCatSelect();
}

/* Populate the category dropdown in the sidebar from the universal list */
function updateCatSelect() {
  var sel = document.getElementById('catSel');
  sel.innerHTML = '';
  for (var i = 0; i < UNIVERSAL_CATS.length; i++) {
    var o = document.createElement('option');
    o.value = UNIVERSAL_CATS[i]; o.textContent = UNIVERSAL_CATS[i];
    sel.appendChild(o);
  }
  /* Sync the category badge to whichever option is pre-selected */
  updateCatBadge(sel.value);
}

/* ── Category filter tabs ────────────────────────────────────────────────────── */
function renderCatTabs() {
  var wrap = document.getElementById('catTabs');
  if (!wrap) return;
  wrap.innerHTML = '';

  var data = interests[bubble] || {};
  /* Only show tabs for categories that actually have at least one interest */
  var cats = Object.keys(data).filter(function(c) { return (data[c] || []).length > 0; });
  if (!cats.length) { document.getElementById('catTabsWrap') && (document.querySelector('.cat-tabs-wrap').style.display = 'none'); return; }
  var tabsWrap = document.querySelector('.cat-tabs-wrap');
  if (tabsWrap) tabsWrap.style.display = '';

  /* Count new items per category for unread badges */
  var newCounts = {};
  var allItems = liveItems.concat(feed[bubble] || []);
  allItems.forEach(function(item) {
    if (item.dismissed) return;
    if (lastVisitTs > 0 && item.ts && item.ts > lastVisitTs) {
      newCounts[item.cat] = (newCounts[item.cat] || 0) + 1;
    }
  });
  var totalNew = Object.keys(newCounts).reduce(function(s, k) { return s + newCounts[k]; }, 0);

  function makeBadge(count) {
    if (!count) return null;
    var b = document.createElement('span');
    b.className = 'tab-badge';
    b.textContent = count;
    return b;
  }

  /* "All" tab — always first */
  var allTab = document.createElement('button');
  allTab.className = 'cat-tab' + (activeCat === null ? ' active' : '');
  allTab.appendChild(document.createTextNode('All'));
  var allBadge = makeBadge(totalNew);
  if (allBadge) allTab.appendChild(allBadge);
  allTab.onclick = function() { setActiveCat(null); };
  wrap.appendChild(allTab);

  cats.forEach(function(cat) {
    var col = CAT_COLORS[cat] || CAT_COLORS['Other'];
    var tab = document.createElement('button');
    tab.className = 'cat-tab' + (activeCat === cat ? ' active' : '');
    tab.appendChild(document.createTextNode(cat));
    var catBadge = makeBadge(newCounts[cat]);
    if (catBadge) tab.appendChild(catBadge);
    if (activeCat === cat) {
      tab.style.borderBottomColor = col.c;
      tab.style.color = col.c;
    }
    tab.onclick = function() { setActiveCat(cat); };
    wrap.appendChild(tab);
  });
}

function setActiveCat(cat) {
  activeCat = cat;
  activeEnt = null;   // category switch clears any entity filter
  renderCatTabs();
  renderSidebar();
  renderFeed();
  /* Sync the category select in the search bar to the active tab */
  if (cat) {
    var sel = document.getElementById('catSel');
    if (sel) sel.value = cat;
    updateCatBadge(cat);
  }
}

/* Toggle entity-level feed filter from sidebar tag click */
function setActiveEnt(entName, cat) {
  /* Toggle off if already active */
  if (activeEnt === entName) {
    activeEnt = null;
  } else {
    activeEnt = entName;
    /* Also set the category tab so the sidebar locks to the right group */
    if (activeCat !== cat) {
      activeCat = cat;
      renderCatTabs();
    }
  }
  renderSidebar();
  renderFeed();
}

/* ── Dynamic tab bar ─────────────────────────────────────────────────────────── */
function renderTabs() {
  var bar = document.getElementById('tabBar');
  bar.innerHTML = '';

  var canAdd = isPaid || spaces.length < MAX_FREE_SPACES + 1;
  // Note: free users can only ever have 1 space; the add button is always
  // shown so they can discover the paid feature, but disabled/locked.

  for (var i = 0; i < spaces.length; i++) {
    (function(name) {
      var isActive = (name === bubble);
      var btn = document.createElement('button');
      btn.className = 'tab' + (isActive ? ' active' : '');

      /* Editable label — double-click to rename */
      var lbl = document.createElement('span');
      lbl.className   = 'tab-label';
      lbl.textContent = name;
      lbl.title       = 'Double-click to rename';
      lbl.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        startRenameSpace(name, lbl, btn);
      });
      btn.appendChild(lbl);

      /* Remove button — only shown when there are 2+ spaces */
      if (spaces.length > 1) {
        var rm = document.createElement('button');
        rm.className            = 'tab-rm';
        rm.innerHTML            = '&times;';
        rm.setAttribute('aria-label', 'Remove ' + name + ' space');
        rm.addEventListener('click', function(e) {
          e.stopPropagation();
          removeSpace(name);
        });
        btn.appendChild(rm);
      }

      btn.addEventListener('click', function() { switchBubble(name); });
      bar.appendChild(btn);
    })(spaces[i]);
  }

  /* ＋ Add Space button */
  var atLimit = !isPaid && spaces.length >= MAX_FREE_SPACES + 1;
  // Free: 1 space. Paid: up to 10. We always show the button; lock it when at free limit.
  var addBtn = document.createElement('button');
  addBtn.className = 'tab tab-add' + (atLimit ? ' tab-add-locked' : '');
  addBtn.setAttribute('aria-label', atLimit ? 'Upgrade to add more spaces' : 'Add a new space');

  if (atLimit) {
    /* Lock icon + label */
    addBtn.innerHTML =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="3" y="11" width="18" height="11" rx="2"/>' +
        '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>' +
      '</svg>' +
      '<span>Space</span>';
    addBtn.addEventListener('click', showUpgradeNudge);
  } else {
    addBtn.innerHTML = '<span>＋ Space</span>';
    addBtn.addEventListener('click', promptAddSpace);
  }
  bar.appendChild(addBtn);
}

/* ── Space management ────────────────────────────────────────────────────────── */

/* Kick off an inline rename on the tab label */
function startRenameSpace(name, labelEl, btnEl) {
  var input = document.createElement('input');
  input.className   = 'tab-rename-input';
  input.value       = name;
  input.maxLength   = 24;
  input.spellcheck  = false;

  /* Swap label for input */
  btnEl.replaceChild(input, labelEl);
  input.focus();
  input.select();

  function commit() {
    var newName = input.value.trim();
    if (newName && newName !== name) {
      renameSpace(name, newName);
    } else {
      /* Restore label if nothing changed / empty */
      btnEl.replaceChild(labelEl, input);
    }
  }

  input.addEventListener('blur',  commit);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = name; input.blur(); }
  });
}

function addSpace(name) {
  if (!name) return;
  spaces.push(name);
  interests[name] = {};
  feed[name]      = [];
  saveState();
  switchBubble(name);
}

function removeSpace(name) {
  /* Always confirm before deleting — show a custom modal */
  showDeleteConfirm(name);
}

function doRemoveSpace(name) {
  var idx = spaces.indexOf(name);
  if (idx === -1 || spaces.length <= 1) return;
  spaces.splice(idx, 1);
  delete interests[name];
  delete feed[name];
  /* Switch away if we're on the deleted space */
  if (bubble === name) bubble = spaces[Math.max(0, idx - 1)];
  mbItems = []; gnItems = []; liveItems = [];
  saveState();
  render();
  loadMusicBrainzFeed();
  loadGoogleNewsFeed();
}

function showDeleteConfirm(name) {
  /* Remove any existing confirm */
  var existing = document.getElementById('delete-confirm');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id        = 'delete-confirm';
  overlay.className = 'modal-overlay';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });

  var box = document.createElement('div');
  box.className = 'modal-box';
  box.innerHTML =
    '<div class="modal-icon">⚠️</div>' +
    '<h3 class="modal-title">Delete "' + name + '"?</h3>' +
    '<p class="modal-body">This will permanently remove the <strong>' + name + '</strong> space and all ' + countInterests(name) + ' interests inside it. This can\'t be undone.</p>' +
    '<div class="modal-actions">' +
      '<button class="modal-btn modal-cancel" id="mc-cancel">Cancel</button>' +
      '<button class="modal-btn modal-delete" id="mc-delete">Delete Space</button>' +
    '</div>';

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  document.getElementById('mc-cancel').focus();
  document.getElementById('mc-cancel').addEventListener('click', function() { overlay.remove(); });
  document.getElementById('mc-delete').addEventListener('click', function() { overlay.remove(); doRemoveSpace(name); });

  /* Keyboard: Escape = cancel */
  overlay.addEventListener('keydown', function(e) { if (e.key === 'Escape') overlay.remove(); });
}

/* Count total interests in a space */
function countInterests(spaceName) {
  var data = interests[spaceName] || {};
  var n = 0;
  for (var cat in data) n += (data[cat] || []).length;
  return n;
}

/* ── Reset all data (call from browser console: resetAllData()) ───────────────── */
function resetAllData() {
  ['vigil_spaces','vigil_interests','vigil_dismissed','vigil_tab',
   'vigil_live_dismissed','vigil_interest_urls','vigil_mb_cache','vigil_paid'
  ].forEach(function(k) { localStorage.removeItem(k); });

  /* Reset runtime state to clean defaults */
  spaces       = ['Personal'];
  bubble       = 'Personal';
  isPaid       = false;
  interests    = { Personal: {} };
  feed         = { Personal: [] };
  mbItems       = [];
  gnItems       = [];
  liveItems     = [];
  liveDismissed = [];
  interestUrls  = {};
  MB_CACHE      = {};
  GN_CACHE      = {};
  ESPN_CACHE    = {};
  localStorage.removeItem('vigil_gn_cache');

  render();
  loadMusicBrainzFeed();
  loadGoogleNewsFeed();
  showToast('Data reset — fresh start!');
}

function renameSpace(oldName, newName) {
  /* Prevent duplicate names */
  if (spaces.indexOf(newName) > -1) { showToast('A space named "' + newName + '" already exists'); return; }
  var idx = spaces.indexOf(oldName);
  if (idx === -1) return;
  spaces[idx] = newName;
  /* Move interests and feed data to new key */
  interests[newName] = interests[oldName] || {};
  delete interests[oldName];
  feed[newName] = feed[oldName] || [];
  delete feed[oldName];
  if (bubble === oldName) bubble = newName;
  saveState();
  render();
}

function promptAddSpace() {
  var name = prompt('Name your new space:', '');
  if (!name) return;
  name = name.trim().slice(0, 24);
  if (!name) return;
  if (spaces.indexOf(name) > -1) { showToast('A space named "' + name + '" already exists'); return; }
  addSpace(name);
}

/* Upgrade nudge — inline tooltip anchored to the add button */
function showUpgradeNudge() {
  var existing = document.getElementById('upgrade-nudge');
  if (existing) { existing.remove(); return; }  // toggle off
  var nudge = document.createElement('div');
  nudge.id        = 'upgrade-nudge';
  nudge.className = 'upgrade-nudge';
  nudge.innerHTML =
    '<strong>Unlock more spaces</strong>' +
    '<p>Free accounts include 1 space. Upgrade to add up to 10.</p>' +
    '<button class="btn-upgrade" onclick="showToast(\'Upgrade flow coming soon!\'); document.getElementById(\'upgrade-nudge\').remove();">Upgrade to Pro</button>';
  document.body.appendChild(nudge);
  /* Position below the add button */
  var bar  = document.getElementById('tabBar');
  var rect = bar.getBoundingClientRect();
  nudge.style.top  = (rect.bottom + 8) + 'px';
  nudge.style.left = (rect.left)       + 'px';
  /* Click outside to dismiss */
  setTimeout(function() {
    document.addEventListener('click', function dismiss(e) {
      if (!nudge.contains(e.target)) { nudge.remove(); document.removeEventListener('click', dismiss); }
    });
  }, 0);
}

/* Scroll the feed to the first card for a given entity and flash-highlight it */
function scrollToEntity(entName) {
  var card = document.querySelector('.item[data-ent="' + CSS.escape(entName) + '"]');
  if (!card) { showToast('No feed items for ' + entName + ' yet'); return; }
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  /* Flash highlight — remove first in case it's already running */
  card.classList.remove('flash');
  void card.offsetWidth; /* force reflow to restart animation */
  card.classList.add('flash');
  card.addEventListener('animationend', function() { card.classList.remove('flash'); }, { once: true });
  /* On mobile, close the drawer so the card is visible */
  closeDrawer();
}

function renderSidebar() {
  /* Update sidebar title to reflect active entity or category */
  var titleEl = document.getElementById('sidebarTitle');
  if (titleEl) titleEl.textContent = activeEnt || activeCat || 'My Interests';

  /* Count new (unread) items per entity */
  var entNewCounts = {};
  var allFeedItems = liveItems.concat(feed[bubble] || []);
  allFeedItems.forEach(function(item) {
    if (item.dismissed) return;
    if (lastVisitTs > 0 && item.ts && item.ts > lastVisitTs) {
      entNewCounts[item.ent] = (entNewCounts[item.ent] || 0) + 1;
    }
  });

  var el   = document.getElementById('iList');
  var data = interests[bubble];
  /* When a category tab is active, lock the sidebar to just that category */
  var keys = activeCat ? (data[activeCat] ? [activeCat] : []) : Object.keys(data);
  el.innerHTML = '';
  for (var k = 0; k < keys.length; k++) {
    var cat  = keys[k];
    var ents = data[cat];
    if (!ents.length) continue;
    var g   = document.createElement('div'); g.className = 'cat-group';
    /* Only show the category label in the "All" view — redundant when locked */
    if (!activeCat) {
      var lbl = document.createElement('div'); lbl.className = 'cat-label';
      var icon = CAT_ICONS && CAT_ICONS[cat] ? CAT_ICONS[cat] + ' ' : '';
      lbl.textContent = icon + cat;
      var col0 = CAT_COLORS[cat];
      if (col0) lbl.style.color = col0.c;
      g.appendChild(lbl);
    }
    var col = CAT_COLORS[cat] || CAT_COLORS['Other'];
    for (var i = 0; i < ents.length; i++) {
      var isActiveEnt = (activeEnt === ents[i]);
      var t  = document.createElement('div');
      t.className = isActiveEnt ? 'tag tag-active' : 'tag';
      /* Apply category colour highlight to active tag */
      if (isActiveEnt) {
        t.style.borderColor = col.c;
        t.style.background  = col.bg;
      }
      var nm = document.createElement('span');
      nm.className = isActiveEnt ? 'tag-name tag-name-active' : 'tag-name';
      if (isActiveEnt) nm.style.color = col.c;
      nm.textContent = ents[i];
      /* Small link indicator if this interest has a URL */
      if (interestUrls[ents[i]]) {
        nm.classList.add('tag-has-url');
        nm.title = interestUrls[ents[i]];
      }
      /* Click entity name → toggle entity filter (click again to clear) */
      (function(entName, catName) {
        nm.onclick = function() { setActiveEnt(entName, catName); };
      })(ents[i], cat);
      t.appendChild(nm);
      /* Per-entity unread count badge */
      var entCount = entNewCounts[ents[i]];
      if (entCount) {
        var entBadge = document.createElement('span');
        entBadge.className = 'tab-badge';
        entBadge.style.marginLeft = '4px';
        entBadge.textContent = entCount;
        t.appendChild(entBadge);
      }
      /* Fetch error indicator */
      if (fetchErrors[ents[i]]) {
        var errIcon = document.createElement('span');
        errIcon.className = 'tag-err';
        errIcon.title = 'Couldn\'t load news — refresh to retry';
        errIcon.textContent = '⚠';
        t.appendChild(errIcon);
      }
      var rfr = document.createElement('button');
      rfr.className = 'tag-rf';
      rfr.textContent = '↻';
      rfr.setAttribute('aria-label', 'Refresh ' + ents[i]);
      rfr.setAttribute('data-ent', ents[i]);
      rfr.setAttribute('data-cat', cat);
      (function(entName, catName) {
        rfr.onclick = function(e) {
          e.stopPropagation();
          refreshEntity(entName, catName);
        };
      })(ents[i], cat);
      t.appendChild(rfr);
      var rm = document.createElement('button');
      rm.className = 'tag-rm';
      rm.textContent = '×';
      rm.setAttribute('aria-label', 'Remove ' + ents[i]);
      rm.setAttribute('data-cat', cat);
      rm.setAttribute('data-ent', ents[i]);
      rm.onclick = function() {
        var c   = this.getAttribute('data-cat');
        var ent = this.getAttribute('data-ent');
        var arr = interests[bubble][c];
        var ix  = arr.indexOf(ent);
        if (ix > -1) arr.splice(ix, 1);
        /* Evict from caches so removal is reflected immediately */
        delete MB_CACHE[ent];
        delete GN_CACHE[ent];
        mbItems   = mbItems.filter(function(item) { return item.ent !== ent; });
        gnItems   = gnItems.filter(function(item) { return item.ent !== ent; });
        liveItems = mbItems.concat(gnItems);
        saveState();
        renderCatTabs();
        renderSidebar();
        renderFeed();
      };
      t.appendChild(rm);
      g.appendChild(t);
    }
    el.appendChild(g);
  }
}

function makeCard(item) {
  var isStale = !!item.stale;
  var isMb       = item.source === 'musicbrainz';
  var isGuardian = item.source === 'guardian';
  var isGn       = isGuardian; // back-compat alias used in expand logic below
  var isEspn     = item.source === 'espn';
  var isLive  = !!item.source;
  var col     = CAT_COLORS[item.cat] || CAT_COLORS['Other'];

  /* Is this item new since the last page load? */
  var isNew = lastVisitTs > 0 && item.ts && item.ts > lastVisitTs;

  /* Is the description just a repeat of the title? (common with ESPN) */
  var descIsDup = !item.desc || item.desc.trim() === item.title.trim();

  var el = document.createElement('div');
  el.className = isStale ? 'item stale' : 'item';
  if (isNew) el.classList.add('item-new');
  el.id = 'item-' + item.id;
  el.setAttribute('data-ent', item.ent); /* used by sidebar click-to-scroll */
  el.style.setProperty('--item-color', col.c);

  /* Animated left accent bar */
  var accentBar = document.createElement('div'); accentBar.className = 'item-accent-bar';
  el.appendChild(accentBar);

  var body = document.createElement('div'); body.className = 'item-body';

  /* Meta row */
  var meta  = document.createElement('div'); meta.className = 'item-meta';
  var catEl = document.createElement('span'); catEl.className = 'item-cat';
  catEl.style.color = col.c; catEl.style.background = col.bg;
  /* Prepend sport-specific icon for Sports items where we know the sport */
  var sportSvg = (item.cat === 'Sports' && interestSport[item.ent])
    ? (SPORT_ICONS[interestSport[item.ent]] || '')
    : '';
  if (sportSvg) {
    catEl.innerHTML = '<span class="sport-icon" aria-hidden="true">' + sportSvg + '</span>' + item.cat;
  } else {
    catEl.textContent = item.cat;
  }

  /* Entity name — becomes a link if a URL is known for this interest */
  var entUrl = interestUrls[item.ent];
  var entEl;
  if (entUrl) {
    entEl = document.createElement('a');
    entEl.href = entUrl;
    entEl.target = '_blank';
    entEl.rel = 'noopener noreferrer';
    entEl.className = 'item-ent item-ent-link';
  } else {
    entEl = document.createElement('span');
    entEl.className = 'item-ent';
  }
  entEl.textContent = item.ent;

  /* Source indicator — colored dot + name */
  var srcDotColor = isMb ? 'var(--accent)' : isEspn ? 'var(--red)' : isGuardian ? 'var(--blue)' : 'var(--muted)';
  var srcLabel    = isMb ? 'Release' : isEspn ? 'ESPN' : isGuardian ? 'Guardian' : (isStale ? 'Older' : 'New');
  var badge = document.createElement('span');
  badge.className = 'source-indicator';
  badge.style.setProperty('--source-dot-color', srcDotColor);
  badge.innerHTML = '<span class="source-dot"></span>' + srcLabel;
  meta.appendChild(catEl); meta.appendChild(entEl); meta.appendChild(badge);
  /* Unread dot — only for items that arrived since the last page load */
  if (isNew) {
    var newDot = document.createElement('span');
    newDot.className = 'unread-dot';
    newDot.title = 'New since your last visit';
    meta.appendChild(newDot);
  }

  /* A card is expandable only when the panel adds something beyond item.desc:
     - MusicBrainz: streaming links
     - ESPN / Guardian: "Read article" link + non-duplicate description
     - Mock/other items that only repeat item.desc: nothing new → no expand */
  var hasExpandContent = isMb || ((isEspn || isGn) && !!item.url);

  /* Title row + one-liner description (only when desc adds something beyond title) */
  var titleRow = document.createElement('div'); titleRow.className = 'title-row';
  var titleEl  = document.createElement('div'); titleEl.className  = 'item-title item-title-ed'; titleEl.textContent = item.title;
  titleRow.appendChild(titleEl);
  if (hasExpandContent) {
    var chevron = document.createElement('span'); chevron.className = 'expand-chevron'; chevron.innerHTML = SVG.chevron;
    titleRow.appendChild(chevron);
  }
  /* Only render the desc line when it actually adds something */
  var descEl = null;
  if (!descIsDup) {
    descEl = document.createElement('div'); descEl.className = 'item-desc'; descEl.textContent = item.desc;
  }

  /* ── Expand panel — only built when there's content worth showing ── */
  var panel = document.createElement('div'); panel.className = 'item-panel';

  if (isMb) {
    /* MB items: streaming quick-links — search by artist + release title */
    var q = encodeURIComponent(item.ent + ' ' + item.title);
    var streamLinks = [
      { label: 'Spotify',     url: 'https://open.spotify.com/search/' + q,              cls: 'lnk-spotify'  },
      { label: 'YouTube',     url: 'https://music.youtube.com/search?q=' + q,           cls: 'lnk-youtube'  },
      { label: 'Apple Music', url: 'https://music.apple.com/search?term=' + q,          cls: 'lnk-apple'    },
      { label: 'Bandcamp',    url: 'https://bandcamp.com/search?q=' + q,                cls: 'lnk-bandcamp' }
    ];
    var linksLabel = document.createElement('span');
    linksLabel.className = 'panel-listen-label'; linksLabel.textContent = 'Listen on';
    var linksRow = document.createElement('div'); linksRow.className = 'panel-links';
    streamLinks.forEach(function(s) {
      var a = document.createElement('a');
      a.className = 'panel-link ' + s.cls;
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = s.label;
      a.onclick = function(e) { e.stopPropagation(); }; // don't collapse card
      linksRow.appendChild(a);
    });
    panel.appendChild(linksLabel);
    panel.appendChild(linksRow);
  } else if (isEspn || isGn) {
    /* ESPN / Guardian items: "Read article" only — description is already
       visible on the card face so repeating it in the panel causes duplication */
    var gnLinks = document.createElement('div'); gnLinks.className = 'panel-links';
    var readLink = document.createElement('a');
    readLink.className = 'panel-link'; readLink.textContent = 'Read article ↗';
    readLink.href = item.url; readLink.target = '_blank'; readLink.rel = 'noopener noreferrer';
    readLink.onclick = function(e) { e.stopPropagation(); };
    gnLinks.appendChild(readLink);
    panel.appendChild(gnLinks);
  } else {
    /* Mock/other items: reveal the full description text */
    var fullDesc = document.createElement('p');
    fullDesc.className = 'panel-full-desc'; fullDesc.textContent = item.desc;
    panel.appendChild(fullDesc);
  }

  body.appendChild(meta); body.appendChild(titleRow);
  if (descEl) body.appendChild(descEl);
  body.appendChild(panel);

  /* Expand on click — only when there's extra content to reveal */
  if (hasExpandContent) {
    el.onclick = function(e) {
      if (e.target.closest('.item-controls')) return;
      if (e.target.closest('.panel-link'))    return;
      el.classList.toggle('expanded');
    };
  } else {
    el.style.cursor = 'default';
  }

  /* Controls: time · view · dismiss · share */
  var controls = document.createElement('div'); controls.className = 'item-controls';
  var timeEl   = document.createElement('span'); timeEl.className = 'item-time'; timeEl.textContent = item.time;

  var viewLabel  = isMb ? 'View' : (isGn || isEspn) ? 'Read' : 'View';
  var btnView = document.createElement('button');
  btnView.className = 'btn-icon';
  btnView.innerHTML = SVG.eye + '<span class="btn-label">' + viewLabel + '</span>';
  btnView.setAttribute('aria-label', isMb ? 'View on MusicBrainz' : (isGn || isEspn) ? 'Read article' : 'View');
  btnView.setAttribute('data-id', String(item.id));
  btnView.onclick = function() { viewItem(this.getAttribute('data-id')); };

  var btnDis = document.createElement('button');
  btnDis.className = 'btn-icon dis';
  btnDis.innerHTML = SVG.close + '<span class="btn-label">Dismiss</span>';
  btnDis.setAttribute('aria-label', 'Dismiss');
  btnDis.setAttribute('data-id', String(item.id));
  btnDis.onclick = function() { dismissItem(this.getAttribute('data-id')); };

  var btnShare = document.createElement('button');
  btnShare.className = 'btn-icon';
  btnShare.innerHTML = SVG.share + '<span class="btn-label">Share</span>';
  btnShare.setAttribute('aria-label', 'Share');
  btnShare.setAttribute('data-id', String(item.id));
  btnShare.onclick = function() { shareItem(this.getAttribute('data-id')); };

  controls.appendChild(timeEl); controls.appendChild(btnView); controls.appendChild(btnShare); controls.appendChild(btnDis);
  el.appendChild(body); el.appendChild(controls);

  /* Swipe-to-dismiss (mobile) — left swipe past threshold triggers dismiss */
  var swipeStartX, swipeStartY, isSwiping = false;
  el.addEventListener('touchstart', function(e) {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    isSwiping = false;
  }, { passive: true });
  el.addEventListener('touchmove', function(e) {
    var dx = e.touches[0].clientX - swipeStartX;
    var dy = e.touches[0].clientY - swipeStartY;
    if (!isSwiping) {
      if (Math.abs(dy) >= Math.abs(dx) || Math.abs(dx) < 8) return;
      isSwiping = true;
    }
    if (dx < 0) {
      e.preventDefault();
      el.style.transform = 'translateX(' + dx + 'px)';
      el.style.opacity   = String(Math.max(0, 1 + dx / 200));
    }
  }, { passive: false });
  el.addEventListener('touchend', function(e) {
    if (!isSwiping) return;
    isSwiping = false;
    var dx = e.changedTouches[0].clientX - swipeStartX;
    if (dx < -80) {
      /* Commit: fly out left, collapse height, then hand off to dismissItem */
      el.style.transition = 'transform 0.18s ease, opacity 0.18s ease';
      el.style.transform  = 'translateX(-110%)';
      el.style.opacity    = '0';
      setTimeout(function() {
        el.style.transition    = 'max-height 0.18s ease, padding-top 0.18s ease, padding-bottom 0.18s ease';
        el.style.overflow      = 'hidden';
        el.style.maxHeight     = el.scrollHeight + 'px';
        requestAnimationFrame(function() { requestAnimationFrame(function() {
          el.style.maxHeight     = '0';
          el.style.paddingTop    = '0';
          el.style.paddingBottom = '0';
        }); });
        setTimeout(function() { dismissItem(String(item.id)); }, 200);
      }, 180);
    } else {
      /* Cancel: spring back */
      el.style.transition = 'transform 0.3s cubic-bezier(0.34,1.3,0.64,1), opacity 0.25s ease';
      el.style.transform  = '';
      el.style.opacity    = '';
      setTimeout(function() { el.style.transition = ''; }, 310);
    }
  });

  return el;
}

function renderFeed() {
  /* Category filter — null means show everything */
  var filterCat = activeCat;
  var filterEnt = activeEnt;   // entity-level filter (takes priority for title)

  var items = feed[bubble];
  var fresh = [], stale = [];
  for (var i = 0; i < items.length; i++) {
    if (items[i].dismissed) continue;
    if (filterCat && items[i].cat !== filterCat) continue;
    if (filterEnt && items[i].ent !== filterEnt) continue;
    if (pendingDismiss && String(items[i].id) === pendingDismiss.id) continue;
    if (items[i].stale) stale.push(items[i]);
    else fresh.push(items[i]);
  }

  /* Split live items into fresh/stale so they sort with their mock counterparts */
  var liveFresh = [], liveStale = [];
  for (var j = 0; j < liveItems.length; j++) {
    if (liveItems[j].dismissed) continue;
    if (filterCat && liveItems[j].cat !== filterCat) continue;
    if (filterEnt && liveItems[j].ent !== filterEnt) continue;
    /* Skip items currently mid-dismiss (undo still available) */
    if (pendingDismiss && String(liveItems[j].id) === pendingDismiss.id) continue;
    if (liveItems[j].stale) liveStale.push(liveItems[j]);
    else liveFresh.push(liveItems[j]);
  }

  /* Live items lead each section — real data first, mock below */
  var allFresh = liveFresh.concat(fresh);
  var allStale = liveStale.concat(stale);

  /* Feed title: entity name > category name > space name */
  document.getElementById('feedTitle').textContent =
    filterEnt  ? filterEnt :
    filterCat  ? filterCat + ' Feed' :
                 bubble + ' Feed';
  document.getElementById('feedCount').textContent = allFresh.length + ' new';

  var list = document.getElementById('feedList');
  list.innerHTML = '';

  /* Loading indicators — MB shows a progress bar; GN shows a simple banner */
  if (liveLoading) {
    list.appendChild(buildFeedLoader());
    var pendingCount = Math.max(liveLoadingTotal - liveLoadingDone, 1);
    for (var s = 0; s < pendingCount; s++) {
      list.appendChild(makeSkeletonCard(s * 120));  // stagger shimmer by 120ms per card
    }
  }
  if (gnLoading && !liveLoading) {
    list.appendChild(buildGnLoader());
  }

  if (!allFresh.length && !allStale.length && !liveLoading) {
    var empty = document.createElement('div'); empty.className = 'empty';
    var ei    = document.createElement('div'); ei.className = 'ei'; ei.textContent = '✨';
    var ep    = document.createElement('p');   ep.textContent = 'All caught up. New items will appear here when your tracked interests have updates.';
    empty.appendChild(ei); empty.appendChild(ep);
    list.appendChild(empty);
    return;
  }

  var sortedFresh = sortItems(allFresh);
  var sortedStale = sortItems(allStale);
  for (var k = 0; k < sortedFresh.length; k++) { list.appendChild(makeCard(sortedFresh[k])); }
  for (var m = 0; m < sortedStale.length; m++) { list.appendChild(makeCard(sortedStale[m])); }
}

/* ── Sorting ─────────────────────────────────────────────────────────────────── */
function setSort(order) {
  sortOrder = order;
  var btns = document.querySelectorAll('.sort-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].className = btns[i].textContent.toLowerCase() === order ? 'sort-btn active' : 'sort-btn';
  }
  renderFeed();
}

function sortItems(arr) {
  var copy = arr.slice();
  if (sortOrder === 'newest')   return copy.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
  if (sortOrder === 'oldest')   return copy.sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
  if (sortOrder === 'category') return copy.sort(function(a, b) { return a.cat.localeCompare(b.cat) || a.ent.localeCompare(b.ent); });
  return copy;
}

/* ── Tab & drawer ────────────────────────────────────────────────────────────── */
function switchBubble(b) {
  bubble    = b;
  mbItems   = []; gnItems = []; liveItems = []; // clear stale live data before render
  saveState();
  render();
  loadMusicBrainzFeed();
  loadGoogleNewsFeed();
}

/* ── Feed refresh ─────────────────────────────────────────────────────────────── */
function refreshFeed() {
  var btn = document.getElementById('btnRefresh');
  if (btn) { btn.classList.add('spinning'); }

  /* Bust GN cache for every interest in the current space */
  var ents = interests[bubble] || {};
  for (var entName in ents) { delete GN_CACHE[entName]; }

  /* Clear MB cache (just the in-memory copy — forces re-fetch this session) */
  for (var mbKey in MB_CACHE) { delete MB_CACHE[mbKey]; }

  /* Reset live state and reload both feeds */
  mbItems = []; gnItems = []; liveItems = [];
  render();
  loadMusicBrainzFeed();
  loadGoogleNewsFeed();

  /* Re-stamp lastVisitTs so newly fetched items won't all be flagged "new" */
  lastVisitTs = Date.now();
  localStorage.setItem('vigil_last_visit', String(lastVisitTs));

  setTimeout(function() {
    if (btn) btn.classList.remove('spinning');
    showToast('Feed refreshed');
  }, 900);
}

function openDrawer() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('btnInterests').setAttribute('aria-expanded', 'true');
  document.body.classList.add('drawer-open');
}
function closeDrawer() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('btnInterests').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('drawer-open');
}

/* ── Feed actions ────────────────────────────────────────────────────────────── */

/* Locate an item by string ID across live and mock feeds */
function findItem(id) {
  var sid = String(id);
  for (var i = 0; i < liveItems.length; i++) {
    if (String(liveItems[i].id) === sid) return { item: liveItems[i], source: 'live' };
  }
  var mockItems = feed[bubble];
  for (var j = 0; j < mockItems.length; j++) {
    if (String(mockItems[j].id) === sid) return { item: mockItems[j], source: 'mock' };
  }
  return null;
}

/* ── Undo-dismiss system ─────────────────────────────────────────────────────── */
var pendingDismiss = null; // { id, found, timeoutId }

function dismissItem(id) {
  /* If another dismiss is already pending, commit it immediately */
  if (pendingDismiss) { _commitDismissNow(pendingDismiss); pendingDismiss = null; }

  var found = findItem(id);
  if (!found) return;

  /* Animate the card out (opacity + slide right) */
  var el = document.getElementById('item-' + id);
  if (el) {
    el.style.transition  = 'opacity 0.18s ease, transform 0.18s ease';
    el.style.opacity     = '0';
    el.style.transform   = 'translateX(18px)';
    /* Collapse the card's height after it fades */
    setTimeout(function() {
      if (!el.parentNode) return;
      var h = el.offsetHeight;
      el.style.transition = 'opacity 0.18s, transform 0.18s, max-height 0.22s ease, margin-bottom 0.22s ease, padding-top 0.22s ease, padding-bottom 0.22s ease';
      el.style.maxHeight     = h + 'px';
      el.style.overflow      = 'hidden';
      el.style.paddingTop    = el.style.paddingTop || '';
      /* Force a frame then collapse */
      requestAnimationFrame(function() {
        el.style.maxHeight    = '0';
        el.style.marginBottom = '0';
        el.style.paddingTop   = '0';
        el.style.paddingBottom= '0';
      });
    }, 180);
  }

  /* Schedule the real dismiss after 5 s */
  var sid = String(id);
  var timeoutId = setTimeout(function() {
    if (pendingDismiss && pendingDismiss.id === sid) {
      _commitDismissNow(pendingDismiss);
      pendingDismiss = null;
      hideUndoToast();
      renderFeed();
    }
  }, 5000);

  pendingDismiss = { id: sid, found: found, timeoutId: timeoutId };
  showUndoToast();
}

/* Actually write the dismiss to state — no DOM changes, just data */
function _commitDismissNow(pd) {
  pd.found.item.dismissed = true;
  if (pd.found.source === 'live') {
    if (liveDismissed.indexOf(pd.id) === -1) liveDismissed.push(pd.id);
    saveLiveState();
  } else {
    saveState();
  }
}

function undoDismiss() {
  if (!pendingDismiss) return;
  clearTimeout(pendingDismiss.timeoutId);
  pendingDismiss = null;
  hideUndoToast();
  renderFeed(); /* item was never marked dismissed — re-render restores it */
}

function showUndoToast() {
  var t    = document.getElementById('undoToast');
  var fill = document.getElementById('undoBarFill');
  if (!t || !fill) return;
  /* Reset bar width synchronously, then trigger the 5s depletion */
  fill.classList.remove('depleting');
  void fill.offsetWidth; /* force reflow so transition restarts cleanly */
  t.className = 'undo-toast show';
  fill.classList.add('depleting');
}

function hideUndoToast() {
  var t = document.getElementById('undoToast');
  if (t) t.className = 'undo-toast';
}

function dismissAll() {
  var items = feed[bubble];
  for (var i = 0; i < items.length; i++) { items[i].dismissed = true; }
  saveState();
  for (var j = 0; j < liveItems.length; j++) {
    liveItems[j].dismissed = true;
    var sid = String(liveItems[j].id);
    if (liveDismissed.indexOf(sid) === -1) liveDismissed.push(sid);
  }
  saveLiveState();
  renderFeed();
}

function viewItem(id) {
  var found = findItem(id);
  if (!found) return;
  if (found.item.url) {
    window.open(found.item.url, '_blank', 'noopener,noreferrer');
  } else {
    showToast('View: ' + found.item.title);
  }
}

function shareItem(id) {
  var found = findItem(id);
  if (!found) return;
  var text = found.item.url || found.item.title;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text);
    showToast('Copied to clipboard');
  } else {
    showToast('Share: ' + found.item.title);
  }
}

/* ── Entity resolution ───────────────────────────────────────────────────────── */
var MOCK_ENTITIES = {
  'mastodon':         [{ name:'Mastodon',           meta:'Band · Progressive Metal · Atlanta, GA' },
                       { name:'Mastodon',           meta:'Social Network · Fediverse platform' }],
  'tool':             [{ name:'Tool',               meta:'Band · Progressive Metal · Los Angeles, CA' },
                       { name:'Tool',               meta:'Generic software utility (keyword search)' }],
  'opeth':            [{ name:'Opeth',              meta:'Band · Progressive Death Metal · Stockholm' }],
  'alter bridge':     [{ name:'Alter Bridge',       meta:'Band · Hard Rock · Orlando, FL' }],
  'a24':              [{ name:'A24',                meta:'Film Studio · Independent · New York' }],
  'denis villeneuve': [{ name:'Denis Villeneuve',   meta:'Film Director · Dune, Arrival, Blade Runner 2049' }],
  'grand seiko':      [{ name:'Grand Seiko',        meta:'Watch Brand · Luxury · Japan · Since 1960' }],
  'framework laptop': [{ name:'Framework Laptop',   meta:'Tech Product · Modular laptop · Framework Computer' }],
  'svelte':           [{ name:'Svelte',             meta:'JS Framework · Front-end · v5 current' },
                       { name:'SvelteKit',          meta:'JS Framework · Full-stack meta-framework for Svelte' }],
  'firefox devtools': [{ name:'Firefox DevTools',   meta:'Developer Tool · Mozilla Firefox · Browser built-in' }],
  'figma':            [{ name:'Figma',              meta:'Design Tool · UI/UX · Browser & desktop app' }],
  'wcag':             [{ name:'WCAG',               meta:'Standard · Web Content Accessibility Guidelines · W3C' }],
  'a11y project':     [{ name:'The A11Y Project',   meta:'Accessibility · Community resource & checklist' }],
  'nielsen norman':   [{ name:'Nielsen Norman Group', meta:'UX Research · Consulting firm & publications' }]
};

function resolveEntity() {
  var cat = document.getElementById('catSel').value;
  var raw = document.getElementById('entInput').value.trim();
  if (!raw) return;

  /* The "Add as typed" escape hatch — always appended last, styled as fallback */
  var fallback = { name: raw, meta: 'Add as typed — use name exactly as entered', fallback: true };

  if (cat === 'Music') {
    /* Live MusicBrainz artist search */
    showPickerSearching(raw, 'MusicBrainz');
    fetch(MB_BASE + 'artist/?query=artist:' + encodeURIComponent('"' + raw + '"') + '&fmt=json&limit=6')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var candidates = [];
        if (data && data.artists && data.artists.length) {
          data.artists.forEach(function(a) {
            var parts = [];
            if (a.type)               parts.push(a.type);
            if (a.disambiguation)     parts.push(a.disambiguation);
            if (a.area && a.area.name) parts.push(a.area.name);
            if (a.tags && a.tags.length) {
              var top = a.tags.sort(function(x,y){ return y.count - x.count; })[0];
              parts.push(top.name);
            }
            candidates.push({ name: a.name, meta: parts.join(' · ') || 'Artist', verified: true });
          });
        }
        candidates.push(fallback);
        showPicker(cat, candidates);
      })
      .catch(function() {
        showPicker(cat, [{ name: raw, meta: 'Add as typed (search unavailable)', fallback: true }]);
      });

  } else if (cat === 'Sports') {
    /* Live ESPN team search across all configured leagues */
    showPickerSearching(raw, 'ESPN');
    searchEspnTeams(raw, function(candidates) {
      candidates.push(fallback);
      showPicker(cat, candidates);
    });

  } else {
    /* Guardian tags search for all other categories */
    showPickerSearching(raw, 'Guardian');
    searchGuardianEntities(raw, cat, function(candidates) {
      /* Merge in any MOCK_ENTITIES entries not already covered */
      (MOCK_ENTITIES[raw.toLowerCase()] || []).forEach(function(m) {
        var key = m.name.toLowerCase();
        if (!candidates.some(function(c) { return c.name.toLowerCase() === key; })) {
          candidates.push({ name: m.name, meta: m.meta, verified: true });
        }
      });
      candidates.push(fallback);
      showPicker(cat, candidates);
    });
  }
}

/* Show the picker in a "searching…" state while the fetch is in flight.
   `source` is a display label e.g. 'MusicBrainz', 'ESPN', 'Guardian'. */
function showPickerSearching(query, source) {
  hidePicker();
  var slot    = document.getElementById('pickerSlot');
  var picker  = document.createElement('div');
  picker.className = 'entity-picker'; picker.id = 'entityPicker';
  var title   = document.createElement('div');
  title.className = 'entity-picker-title searching';
  title.textContent = 'Searching ' + (source || 'database') + '\u2026';
  var loading = document.createElement('div');
  loading.className = 'picker-searching';
  loading.textContent = '\u201c' + query + '\u201d';
  picker.appendChild(title);
  picker.appendChild(loading);
  slot.innerHTML = '';
  slot.appendChild(picker);
  slot.classList.add('open');
}

function showPicker(cat, candidates) {
  hidePicker();
  var slot        = document.getElementById('pickerSlot');
  var query       = (document.getElementById('entInput').value || '').trim();
  var hasVerified = candidates.some(function(c) { return c.verified; });
  var picker      = document.createElement('div');
  picker.className = 'entity-picker'; picker.id = 'entityPicker';

  /* Title reflects whether we found live matches or are just confirming typed input */
  var title = document.createElement('div'); title.className = 'entity-picker-title';
  title.textContent = hasVerified ? 'Select a match' : 'Confirm entity';
  picker.appendChild(title);

  candidates.forEach(function(c) {
    /* Visual separator before the fallback "add as typed" option */
    if (c.fallback && hasVerified) {
      var sep = document.createElement('div'); sep.className = 'picker-divider';
      picker.appendChild(sep);
    }
    var row  = document.createElement('div');
    row.className = 'entity-candidate' + (c.fallback ? ' entity-candidate-fallback' : '');
    var name = document.createElement('div'); name.className = 'entity-candidate-name';
    name.innerHTML = highlightMatch(c.name, query);
    var meta = document.createElement('div'); meta.className = 'entity-candidate-meta'; meta.textContent = c.meta;
    row.appendChild(name); row.appendChild(meta);
    /* For Sports entities, extract the sport from the meta string ("League · Sport") */
    var sport = (cat === 'Sports' && c.meta && c.meta.indexOf(' · ') !== -1)
      ? c.meta.split(' · ').pop().trim()
      : '';
    row.onclick = (function(eName, eSport) {
      return function() { confirmEntity(cat, eName, eSport); };
    })(c.name, sport);
    picker.appendChild(row);
  });

  slot.innerHTML = '';
  slot.appendChild(picker);
  slot.classList.add('open');
  setTimeout(function() { document.addEventListener('click', dismissPickerOnOutsideClick); }, 0);
}

function dismissPickerOnOutsideClick(e) {
  var wrap = document.getElementById('searchWrap');
  if (wrap && !wrap.contains(e.target)) hidePicker();
}

function hidePicker() {
  var slot = document.getElementById('pickerSlot');
  if (slot) { slot.classList.remove('open'); }
  /* Delay clearing content until after the slide-out transition */
  setTimeout(function() {
    var slot2 = document.getElementById('pickerSlot');
    if (slot2 && !slot2.classList.contains('open')) slot2.innerHTML = '';
  }, 240);
  document.removeEventListener('click', dismissPickerOnOutsideClick);
}

function confirmEntity(cat, name, sport) {
  hidePicker();
  if (!interests[bubble][cat]) interests[bubble][cat] = [];
  var arr = interests[bubble][cat];
  for (var i = 0; i < arr.length; i++) { if (arr[i] === name) { showToast(name + ' already in list'); return; } }
  arr.push(name);
  /* Store sport type for icon rendering (Sports category only) */
  if (sport) { interestSport[name] = sport; saveSportState(); }
  /* Capture optional URL — prepend https:// if the user omitted it */
  var urlInput = document.getElementById('urlInput');
  var urlVal   = urlInput ? urlInput.value.trim() : '';
  if (urlVal) {
    if (!/^https?:\/\//i.test(urlVal)) urlVal = 'https://' + urlVal;
    interestUrls[name] = urlVal;
    saveUrlState();
  }
  document.getElementById('entInput').value = '';
  if (urlInput) urlInput.value = '';
  saveState(); renderCatTabs(); renderSidebar();
  showToast('Added ' + name);
  /* Re-fetch the appropriate feed for the category just added */
  if (cat === 'Music') loadMusicBrainzFeed();
  else { delete GN_CACHE[name]; loadGoogleNewsFeed(); } // bust cache so new entity loads immediately
  if (window.innerWidth < 768) closeDrawer();
}

/* ── Toast ───────────────────────────────────────────────────────────────────── */
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(function() { t.className = 'toast'; }, 2800);
}

/* ── Category badge helper ───────────────────────────────────────────────────── */
function updateCatBadge(cat) {
  var badge = document.getElementById('catBadge');
  if (!badge) return;
  if (!cat) { badge.classList.remove('visible'); badge.textContent = ''; return; }
  var col = CAT_COLORS[cat] || CAT_COLORS['Other'];
  badge.textContent = cat;
  badge.style.background = col.bg;
  badge.style.color = col.c;
  badge.style.borderColor = col.c;
  badge.style.border = '1px solid ' + col.c;
  badge.classList.add('visible');
}

/* ── Highlight query match in a string (returns HTML string) ─────────────────── */
function highlightMatch(text, query) {
  if (!query) return text;
  var escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp('(' + escaped + ')', 'gi'), '<mark>$1</mark>');
}

/* ── Init ────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  var inp     = document.getElementById('entInput');
  var wrap    = document.getElementById('searchWrap');
  var catSel  = document.getElementById('catSel');
  var pickerActiveIndex = -1;

  /* Focus/blur → search-wrap glow */
  inp.addEventListener('focus', function() { wrap.classList.add('focused'); });
  inp.addEventListener('blur',  function() { setTimeout(function() { wrap.classList.remove('focused'); }, 180); });

  /* Category select → badge */
  catSel.addEventListener('change', function() { updateCatBadge(catSel.value); });

  /* Keyboard nav + Enter + Escape */
  inp.addEventListener('keydown', function(e) {
    var candidates = document.querySelectorAll('#pickerSlot .entity-candidate');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      pickerActiveIndex = Math.min(pickerActiveIndex + 1, candidates.length - 1);
      updatePickerActive(candidates, pickerActiveIndex);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      pickerActiveIndex = Math.max(pickerActiveIndex - 1, 0);
      updatePickerActive(candidates, pickerActiveIndex);
      return;
    }
    if (e.key === 'Enter') {
      if (pickerActiveIndex >= 0 && candidates[pickerActiveIndex]) {
        candidates[pickerActiveIndex].click(); // confirm highlighted candidate
      } else {
        resolveEntity();
      }
      return;
    }
    if (e.key === 'Escape') { pickerActiveIndex = -1; hidePicker(); }
  });

  /* Debounced live search: for Music category, fire MusicBrainz picker on input */
  var liveSearchTimer = null;
  inp.addEventListener('input', function() {
    pickerActiveIndex = -1;
    clearTimeout(liveSearchTimer);
    var val = inp.value.trim();
    if (!val) { hidePicker(); return; }
    /* Live search for all categories — Music & Sports use their own APIs,
       Guardian covers everything else. Use a slightly longer debounce for
       non-Music to avoid hammering on short inputs. */
    var delay = catSel.value === 'Music' ? 420 : 520;
    liveSearchTimer = setTimeout(function() { resolveEntity(); }, delay);
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeDrawer();
  });

  /* ── Feed keyboard navigation — j/k to move, o to expand, d to dismiss, v to view ── */
  var kbFeedIdx = -1;
  var kbHintTimer = null;
  function showKbHint() {
    var hint = document.getElementById('kbdHint');
    if (!hint) return;
    hint.classList.add('visible');
    clearTimeout(kbHintTimer);
    kbHintTimer = setTimeout(function() { hint.classList.remove('visible'); }, 3000);
  }

  document.addEventListener('keydown', function(e) {
    /* Don't intercept while typing in any input/select */
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    /* Don't intercept modifier combos (Ctrl+R, Cmd+K, etc.) */
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    var cards = document.querySelectorAll('#feedList .item');
    if (!cards.length) return;

    if (e.key === 'j' || (e.key === 'ArrowDown' && document.activeElement === document.body)) {
      e.preventDefault();
      kbFeedIdx = Math.min(kbFeedIdx + 1, cards.length - 1);
      updateFeedFocus(cards, kbFeedIdx);
      showKbHint();
    } else if (e.key === 'k' || (e.key === 'ArrowUp' && document.activeElement === document.body)) {
      e.preventDefault();
      kbFeedIdx = Math.max(kbFeedIdx - 1, 0);
      updateFeedFocus(cards, kbFeedIdx);
      showKbHint();
    } else if (e.key === 'o' && kbFeedIdx >= 0 && cards[kbFeedIdx]) {
      e.preventDefault();
      cards[kbFeedIdx].click(); /* toggle expand */
    } else if (e.key === 'd' && kbFeedIdx >= 0 && cards[kbFeedIdx]) {
      e.preventDefault();
      var disBtn = cards[kbFeedIdx].querySelector('.btn-icon.dis');
      if (disBtn) {
        disBtn.click();
        /* Clamp index after card disappears */
        setTimeout(function() {
          kbFeedIdx = Math.max(0, Math.min(kbFeedIdx, document.querySelectorAll('#feedList .item').length - 1));
          updateFeedFocus(document.querySelectorAll('#feedList .item'), kbFeedIdx);
        }, 50);
      }
    } else if (e.key === 'v' && kbFeedIdx >= 0 && cards[kbFeedIdx]) {
      e.preventDefault();
      var viewBtn = cards[kbFeedIdx].querySelector('.btn-icon:not(.dis):not([aria-label="Share"])');
      if (viewBtn) viewBtn.click();
    } else if (e.key === 'r' && !e.shiftKey) {
      /* r = refresh feed */
      e.preventDefault();
      refreshFeed();
    }
  });

  /* Reset kb focus index whenever feed re-renders */
  var origRenderFeed = renderFeed;
  renderFeed = function() { kbFeedIdx = -1; origRenderFeed(); };

  loadState();
  render();
  loadMusicBrainzFeed();   // kick off Music release data on startup
  loadGoogleNewsFeed();    // kick off news feed for all other interests
});

/* ── Feed keyboard focus helper ──────────────────────────────────────────────── */
function updateFeedFocus(cards, idx) {
  for (var i = 0; i < cards.length; i++) { cards[i].classList.remove('kb-focused'); }
  if (idx >= 0 && cards[idx]) {
    cards[idx].classList.add('kb-focused');
    cards[idx].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updatePickerActive(candidates, idx) {
  candidates.forEach(function(el, i) { el.classList.toggle('kbd-active', i === idx); });
  if (candidates[idx]) candidates[idx].scrollIntoView({ block: 'nearest' });
}

/* ══════════════════════════════════════════════════════════════════════════════
   AUTH UI — fake/prototype (no backend)
   Everything here is UI-only. Real Firebase auth replaces these functions later.
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Modal open / close ──────────────────────────────────────────────────────── */
function openAuthModal() {
  document.getElementById('authModalOverlay').classList.add('open');
  // Reset form state
  document.getElementById('authEmail').value = '';
  document.getElementById('authPassword').value = '';
  document.getElementById('btnAuthSubmit').disabled = false;
  document.getElementById('btnAuthSubmit').innerHTML = 'Log in';
  // Trap focus: move to email field
  setTimeout(function() { document.getElementById('authEmail').focus(); }, 80);
}

function closeAuthModal() {
  document.getElementById('authModalOverlay').classList.remove('open');
}

function handleOverlayClick(e) {
  if (e.target === document.getElementById('authModalOverlay')) closeAuthModal();
}

// Close on Escape
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closeAuthModal();
    closeUserDropdown();
  }
});

/* ── Sign up button — not wired up yet, just shows a toast ───────────────────── */
document.getElementById('btnSignup').addEventListener('click', function() {
  showToast('Sign up coming soon!');
});

// "Sign up" link inside the modal footer
function handleSignupClick(e) {
  e.preventDefault();
  closeAuthModal();
  showToast('Sign up coming soon!');
}

/* ── Fake email login ────────────────────────────────────────────────────────── */
function handleEmailLogin(e) {
  e.preventDefault();
  var email    = document.getElementById('authEmail').value.trim();
  var password = document.getElementById('authPassword').value;
  if (!email || !password) return;

  // Show loading state
  var btn = document.getElementById('btnAuthSubmit');
  btn.disabled = true;
  btn.innerHTML = '<span class="auth-spinner"></span>Logging in…';

  // Simulate a small network delay — makes it feel real
  setTimeout(function() {
    var displayName = email.split('@')[0];
    loginSuccess({ name: displayName, email: email, provider: 'email' });
  }, 900);
}

/* ── Fake Google login ───────────────────────────────────────────────────────── */
function handleGoogleLogin() {
  var btn = document.getElementById('btnGoogleLogin');
  btn.disabled = true;
  btn.innerHTML = '<span class="auth-spinner" style="border-color:#888;border-top-color:transparent;"></span>Redirecting to Google…';

  setTimeout(function() {
    loginSuccess({ name: 'Demo User', email: 'demo@gmail.com', provider: 'google' });
    btn.disabled = false;
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>Continue with Google';
  }, 1100);
}

/* ── Shared login success handler ────────────────────────────────────────────── */
function loginSuccess(user) {
  closeAuthModal();

  // Swap header buttons
  document.getElementById('authBtns').style.display = 'none';
  var authUser = document.getElementById('authUser');
  authUser.style.display = 'flex';

  // Populate avatar + name
  var avatarEl = document.getElementById('userAvatarEl');
  avatarEl.textContent = user.name.charAt(0).toUpperCase();
  document.getElementById('userNameEl').textContent = user.name;
  document.getElementById('userDropdownEmail').textContent = user.email;

  showToast('Logged in as ' + user.name);
}

/* ── User dropdown ───────────────────────────────────────────────────────────── */
function toggleUserDropdown() {
  var dd   = document.getElementById('userDropdown');
  var chip = document.getElementById('userChip');
  var open = dd.style.display === 'block';
  dd.style.display = open ? 'none' : 'block';
  chip.setAttribute('aria-expanded', String(!open));
}

function closeUserDropdown() {
  var dd = document.getElementById('userDropdown');
  if (dd) {
    dd.style.display = 'none';
    document.getElementById('userChip').setAttribute('aria-expanded', 'false');
  }
}

// Close dropdown when clicking outside it
document.addEventListener('click', function(e) {
  var chip = document.getElementById('userChip');
  var dd   = document.getElementById('userDropdown');
  if (chip && dd && !chip.contains(e.target) && !dd.contains(e.target)) {
    closeUserDropdown();
  }
});

// Keyboard: Enter/Space on chip
document.getElementById('userChip').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleUserDropdown(); }
});

/* ── Logout ──────────────────────────────────────────────────────────────────── */
function handleLogout() {
  closeUserDropdown();
  document.getElementById('authUser').style.display = 'none';
  document.getElementById('authBtns').style.display = 'flex';
  showToast('Logged out');
}
