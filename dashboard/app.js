// Token Radar's plain dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, a filterable table, a per-protocol detail drawer with the model's own
// inputs and the protocol's farm plan. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var ENRICH = DATA.enrichments || {};
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', tier: 'all', watchlistOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  // The value tiers the enrichment layer assigns, largest implied value first, so the
  // tier filter lists them in the same order the board reads them.
  var TIER_ORDER = ['flagship', 'major', 'notable', 'emerging', 'nascent'];

  // Every chain the board's rows run on, sorted, for the chain filter: derived from the
  // rows themselves, so a snapshot with a new chain lists it with no code change.
  function allChains() {
    var seen = {};
    DATA.rows.forEach(function (r) { (r.chains || []).forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  // A row's value tier from its enrichment record; a row with no enrichment reads as
  // nascent, the smallest tier, so the filter never drops a row for missing data.
  function tierOf(row) {
    var e = ENRICH[row.slug];
    return e && e.value_tier ? e.value_tier : 'nascent';
  }

  // Whether a row is one of the 40 watchlist protocols: its slug is in the list main.ts
  // writes beside the board, so the watchlist-only view needs no second source of truth.
  function isWatchlist(row) {
    var slugs = DATA.watchlist_slugs || [];
    return slugs.indexOf(row.slug) >= 0;
  }

  var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  // The model in one function: the page recomputes a row from the snapshot figures and checks the
  // number board.json carries, so the page's code and the board's data are visibly the same arithmetic.
  function categoryMultipleOf(row) {
    var cal = DATA.calibration;
    if (cal) {
      for (var i = 0; i < cal.byCategory.length; i++) {
        if (cal.byCategory[i].category === (row.category || 'Other')) return cal.byCategory[i].multiple;
      }
      return cal.global;
    }
    return row.category_multiple;
  }
  function impliedOf(row, model) {
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = Math.min(1, Math.max(model.maturity_floor, model.maturity_floor + model.maturity_range * (Math.log(1 + Math.max(age, 0) / 365) / Math.log(4))));
    var chains = row.chains ? row.chains.length : 0;
    var chainMult = 1 + model.chain_step * Math.min(Math.max(chains - 1, 0), model.chain_max_steps);
    return Math.max(1, Math.round(row.tvl_usd * categoryMultipleOf(row) * growthMult * maturity * chainMult));
  }

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) node.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) child.forEach(function (c) { if (c) node.appendChild(c); });
      else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + capital + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tier')) state.tier = params.get('tier');
    if (params.get('wl') === '1') state.watchlistOnly = true;
  }
  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.tier !== 'all') params.set('tier', state.tier);
    if (state.watchlistOnly) params.set('wl', '1');
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function rows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.tier !== 'all' && tierOf(r) !== state.tier) return false;
      if (state.watchlistOnly && !isWatchlist(r)) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  // How many of the board's rows survive the filters, and how many the watchlist holds,
  // so the count line under the controls always says what the filters are doing.
  function filterSummary() {
    var shown = rows().length;
    var total = DATA.rows.length;
    var wl = (DATA.watchlist_slugs || []).length;
    var active = [];
    if (state.category !== 'all') active.push(state.category);
    if (state.chain !== 'all') active.push(state.chain);
    if (state.tier !== 'all') active.push(state.tier + ' tier');
    if (state.watchlistOnly) active.push('watchlist only');
    if (state.q.trim()) active.push('"' + state.q.trim() + '"');
    var label = shown + ' of ' + total + ' rows shown';
    if (active.length > 0) label += ' (' + active.join(' + ') + ')';
    if (state.watchlistOnly) label += ' of ' + wl + ' watchlist protocols';
    return label;
  }
  function sortedRows(list) {
    var key = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function controls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = allChains();
    var search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var select = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { state.category = select.value; writeHash(); render(); });
    var chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; writeHash(); render(); });
    var tierSelect = el('select', { id: 'tier', 'aria-label': 'Filter by value tier' },
      el('option', { value: 'all', text: 'All tiers' }),
      TIER_ORDER.map(function (t) { return el('option', { value: t, text: t + ' tier', selected: t === state.tier ? 'selected' : null }); })
    );
    tierSelect.addEventListener('change', function () { state.tier = tierSelect.value; writeHash(); render(); });
    var watchlistBox = el('input', { type: 'checkbox', id: 'watchlist-only', checked: state.watchlistOnly ? 'checked' : null, onchange: function () { state.watchlistOnly = watchlistBox.checked; writeHash(); render(); } });
    var pre = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; render(); } });
    var live = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), select),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('label', { for: 'tier', text: 'Value tier' }), tierSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Watchlist' }), el('label', { class: 'check' }, watchlistBox, 'Watchlist only')),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, pre, live)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? filterSummary() : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = sortedRows(rows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.tier = 'all'; state.watchlistOnly = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = el('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : fmtPct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: fmtAge(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = el('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        el('td', { class: 'num', text: fmtUsd(r.tvl_usd) }),
        el('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: fmtPct(r.change_7d) }),
        el('td', { class: 'num', text: fmtUsd(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  // The methodology note, rendered between the controls and the board table so the
  // first screenshot shows the value model and the ranked rows together. It states
  // the formula in plain language: TVL, priced at the category median, then growth,
  // time with no token, and chain breadth. No protocol name is hardcoded.
  function methodology() {
    return el('section', { class: 'panel model', id: 'methodology', 'aria-labelledby': 'methodology-title' },
      el('h2', { id: 'methodology-title', text: 'How the ranking works' }),
      el('p', { text: "Implied value starts from a protocol's total value locked, priced at its category's median market cap per dollar of TVL, the median across that category's live-token protocols in this same snapshot. Seven-day growth nudges it up or down, longer running with no token counts as riper, and each extra chain adds a little. No protocol name is hardcoded: one formula scores every protocol." })
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var cal = DATA.calibration;
    var rows = cal ? cal.byCategory.slice().sort(function (a, b) { return b.multiple - a.multiple; }) : [];
    var calRows = rows.map(function (c) {
      return el('tr', null,
        el('td', { text: c.category }),
        el('td', { class: 'num', text: c.multiple.toFixed(3) + 'x' }),
        el('td', { class: 'num', text: String(c.n) + ' live' })
      );
    });
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' },
        'implied = round( tvl_usd x category multiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x maturity x chain breadth )'
      ),
      el('p', { class: 'sub', text: 'The category multiple is calibrated on this snapshot: the median market cap per dollar of TVL of the live-token protocols in that line of business (at least ' + m.multiple_min_samples + ' of them; otherwise the global median of ' + (cal ? cal.global.toFixed(3) : 'n/a') + 'x). Lending and staking trade near 0.1x of TVL, exchanges near 0.3x, bridges near 1x: one flat multiple would misprice them all.' }),
      el('p', { class: 'sub', text: 'Maturity is 0.6 + 0.4 x ln(1 + age / 365) / ln(4), at most 1.0: a protocol a year in with no token scores 0.8, three years in scores 1.0. Chain breadth adds 3% a chain, up to 24%. Age is the time since the protocol was first listed; an unlisted age uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol the exclusion rule keeps, whatever its TVL, and the live-token protocols are set aside with their market caps shown.' }),
      el('h3', { text: 'Calibration: market cap per dollar of TVL, from this snapshot' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'cal' },
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Category' }), el('th', { scope: 'col', text: 'Multiple' }), el('th', { scope: 'col', text: 'Live protocols' }))),
          el('tbody', null, calRows)
        )
      )
    );
  }

  function categoryBars() {
    var totals = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Other';
      totals[c] = (totals[c] || 0) + r.implied_value_usd;
    });
    var list = Object.keys(totals).map(function (c) { return { c: c, v: totals[c] }; }).sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
    var max = list.length ? list[0].v : 1;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'Where the implied value sits' }),
      el('p', { class: 'sub', text: 'Total implied value by line of business, across the ' + DATA.board_size + ' pre-token rows.' }),
      el('div', { class: 'catbars' }, list.map(function (item) {
        return el('div', { class: 'catbar' },
          el('span', { class: 'catname', text: item.c }),
          el('div', { class: 'bar wide', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((item.v / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(item.v) })
        );
      }))
    );
  }

  // The category leaders: the single strongest protocol in each line of business, by
  // implied value, so a reader can see at a glance which name leads lending, which leads
  // bridges, and so on, without sorting the whole board. The leader is the row with the
  // largest implied value in its category; ties are impossible, ranks are unique.
  function categoryLeaders() {
    var best = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Other';
      if (!best[c] || r.implied_value_usd > best[c].implied_value_usd) best[c] = r;
    });
    var list = Object.keys(best).map(function (c) { return best[c]; }).sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; });
    var max = list.length ? list[0].implied_value_usd : 1;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'Category leaders' }),
      el('p', { class: 'sub', text: 'The strongest pre-token protocol in each line of business, by implied value. ' + list.length + ' categories, one leader each.' }),
      el('div', { class: 'catbars' }, list.map(function (r) {
        return el('div', { class: 'catbar' },
          el('span', { class: 'catname', text: (r.category || 'Other') + ': ' + r.name + ' (#' + r.rank + ')' }),
          el('div', { class: 'bar wide', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: fmtUsd(r.implied_value_usd) })
        );
      }))
    );
  }

  // One labelled value for the detail view's equation grid: a plain label and a bold figure.
  function detailRow(label, value) {
    return el('div', null, el('span', { text: label }), el('b', { class: 'num', text: value }));
  }

  // One sentence that reads a row's enrichment aloud: its tier, its maturity, and how
  // completely its record is documented, so the numbers above it have a plain-language form.
  function enrichmentNote(row, enrichment) {
    var band = enrichment.confidence_score >= 80 ? 'well documented' : enrichment.confidence_score >= 60 ? 'partly documented' : 'thinly documented';
    var tierWord = enrichment.value_tier === 'flagship' ? 'one of the largest implied values on the board'
      : enrichment.value_tier === 'major' ? 'a large implied value'
      : enrichment.value_tier === 'notable' ? 'a mid-sized implied value'
      : enrichment.value_tier === 'emerging' ? 'a modest implied value'
      : 'a small implied value';
    var ageWord = enrichment.maturity_label === 'unknown age' ? 'with no listing date on record'
      : 'after running ' + fmtAge(row.age_days) + ' with no token';
    return row.name + ' carries ' + tierWord + ' at ' + fmtUsd(row.implied_value_usd) + ', ' + ageWord +
      ', on ' + enrichment.chain_count + ' chain' + (enrichment.chain_count === 1 ? '' : 's') +
      '. Its record is ' + band + ' at ' + enrichment.confidence_score + ' out of 100, and its category holds ' +
      (enrichment.category_context.pre_token_count || 'n/a') + ' pre-token protocols.';
  }

  // The enrichment block for one protocol's detail view: the confidence score, the value tier,
  // the maturity label, and the context of its category, each with a plain label. The confidence
  // score is a completeness read of the row's own record, out of 100: a positive TVL is worth
  // 35, a recorded seven-day change 20, a known category 15, a listing date 15, and chain
  // breadth up to 15. It describes the row; it never moves its rank.
  function enrichmentSection(row) {
    var enrichment = ENRICH[row.slug];
    if (!enrichment) return null;
    var ctx = enrichment.category_context || {};
    var count = ctx.pre_token_count === undefined || ctx.pre_token_count === null ? 'n/a' : String(ctx.pre_token_count);
    var total = ctx.total_tvl_usd === undefined || ctx.total_tvl_usd === null ? 'n/a' : fmtUsd(ctx.total_tvl_usd);
    var medianTvl = ctx.median_tvl_usd === undefined || ctx.median_tvl_usd === null ? 'n/a' : fmtUsd(ctx.median_tvl_usd);
    var benchmark = ctx.benchmark_multiple === undefined || ctx.benchmark_multiple === null ? 'n/a' : String(ctx.benchmark_multiple) + 'x';
    var samples = ctx.live_sample_count === undefined || ctx.live_sample_count === null ? 'n/a' : String(ctx.live_sample_count);
    return el('section', { class: 'detail-section' },
      el('h3', { text: 'Enrichment' }),
      el('div', { class: 'equation' },
        detailRow('Confidence score', String(enrichment.confidence_score) + ' / 100'),
        detailRow('Value tier', enrichment.value_tier),
        detailRow('Maturity label', enrichment.maturity_label),
        detailRow('Chains', String(enrichment.chain_count)),
        detailRow('Protocols in this category', count),
        detailRow('Category total TVL', total),
        detailRow('Category median TVL', medianTvl),
        detailRow('Category benchmark multiple', benchmark)
      ),
      el('p', { class: 'sub', text: enrichmentNote(row, enrichment) }),
      el('p', { class: 'sub', text: 'The benchmark multiple is the median market cap per dollar of TVL of the ' + samples + ' live-token protocol' + (samples === '1' ? '' : 's') + ' in this category in the same snapshot, clamped to the model band of 0.05x to 1.5x. The tier is a reading aid only: flagship is $500M and up, major $100M, notable $25M, emerging $5M, and anything below that nascent.' })
    );
  }

  // The category breakdown lives outside the board shell, in the empty container the page
  // carries for it. It groups the pre-token rows by category and lists each category with its
  // protocol count and its total implied value, largest total first, with a bar scaled to the
  // largest category so the spread across lines of business is visible at a glance.
  function fillCategoryBreakdown() {
    var host = document.getElementById('category-breakdown');
    if (!host) return;
    host.textContent = '';
    var grouped = {};
    DATA.rows.forEach(function (r) {
      var c = r.category || 'Other';
      if (!grouped[c]) grouped[c] = { category: c, count: 0, total: 0, topName: '', topValue: 0, values: [] };
      grouped[c].count += 1;
      grouped[c].total += r.implied_value_usd;
      grouped[c].values.push(r.implied_value_usd);
      if (r.implied_value_usd > grouped[c].topValue) { grouped[c].topValue = r.implied_value_usd; grouped[c].topName = r.name; }
    });
    var list = Object.keys(grouped).map(function (k) {
      var item = grouped[k];
      var ordered = item.values.slice().sort(function (a, b) { return a - b; });
      var mid = Math.floor(ordered.length / 2);
      item.median = ordered.length % 2 === 1 ? ordered[mid] : (ordered[mid - 1] + ordered[mid]) / 2;
      return item;
    });
    list.sort(function (a, b) {
      if (b.total !== a.total) return b.total - a.total;
      return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
    });
    var max = list.length ? list[0].total : 1;
    var grand = list.reduce(function (sum, item) { return sum + item.total; }, 0);
    var heading = el('h2', { text: 'Implied value by category' });
    var intro = el('p', { class: 'sub', text: 'The ' + DATA.board_size + ' pre-token rows grouped by line of business, largest total implied value first. Together they imply ' + fmtUsd(grand) + ' across ' + list.length + ' categories.' });
    var wrap = el('div', { class: 'catbars' }, list.map(function (item) {
      var share = grand > 0 ? Math.round((item.total / grand) * 100) : 0;
      return el('div', { class: 'catbar' },
        el('span', { class: 'catname', text: item.category + ' (' + item.count + ' protocol' + (item.count === 1 ? '' : 's') + ', ' + share + '% of the board)' }),
        el('span', { class: 'sub', text: 'Largest: ' + item.topName + ' at ' + fmtUsd(item.topValue) + ' · median row ' + fmtUsd(item.median) }),
        el('div', { class: 'bar wide', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((item.total / max) * 100)) + '%' })),
        el('span', { class: 'num', text: fmtUsd(item.total) })
      );
    }));
    host.appendChild(el('section', { class: 'panel model' }, heading, intro, wrap));
  }

  // The farm plan in one box: what it takes to farm this protocol, read off the same
  // figures the steps use. Capital and setup gas follow the TVL bands; the weekly gas
  // is $2 a week for the hold, so the gas over the hold is the setup plus the weeks held.
  function farmSummary(row) {
    var chain = chainOf(row);
    var capital = capitalFor(row);
    var hold = holdDaysFor(row.age_days);
    var setupGas = capital >= 150 ? 8 : 4;
    var weeks = Math.max(1, Math.ceil(hold / 7));
    var weeklyGas = 2 * weeks;
    var totalGas = setupGas + weeklyGas;
    return el('section', { class: 'detail-section' },
      el('h3', { text: 'What farming it takes' }),
      el('div', { class: 'equation' },
        detailRow('Capital to commit', '$' + capital),
        detailRow('Setup gas', 'about $' + setupGas),
        detailRow('Weekly gas', 'about $2 a week'),
        detailRow('Hold', hold + ' days (' + weeks + ' weeks)'),
        detailRow('Gas over the hold', 'about $' + totalGas),
        detailRow('Main chain', chain)
      ),
      el('p', { class: 'sub', text: 'The capital stays in the position for the hold; the gas is the cost of the transactions. A fresh wallet holds only these funds, and the claim comes only from the link the protocol itself publishes.' })
    );
  }

  // Where this row sits on the board: its percentile, the median implied value of its
  // own category, and how far it is from the board's top row, so the rank reads as a
  // position, not just a number.
  function rankContext(row) {
    var top = DATA.rows.filter(function (r) { return r.rank === 1; })[0];
    var same = DATA.rows.filter(function (r) { return (r.category || 'Other') === (row.category || 'Other'); }).map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var mid = Math.floor(same.length / 2);
    var medianValue = same.length % 2 === 1 ? same[mid] : (same[mid - 1] + same[mid]) / 2;
    var percentile = Math.round(((DATA.board_size - row.rank + 1) / DATA.board_size) * 100);
    var share = top ? Math.round((row.implied_value_usd / top.implied_value_usd) * 100) : 0;
    return el('section', { class: 'detail-section' },
      el('h3', { text: 'Where this rank sits' }),
      el('p', { class: 'sub', text: row.name + ' is rank ' + row.rank + ' of ' + DATA.board_size + ', the top ' + percentile + '% of the board. Its category median is ' + fmtUsd(medianValue) + ', and it carries ' + share + '% of the top row' + (top ? ' (' + top.name + ' at ' + fmtUsd(top.implied_value_usd) + ')' : '') + '.' })
    );
  }

  var dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = farmSteps(row);
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: fmtUsd(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Category multiple' }), el('b', { class: 'num', text: String(row.category_multiple) + 'x' })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: fmtPct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: fmtAge(row.age_days) })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Chain breadth' }), el('b', { class: 'num', text: String(row.chain_multiplier) + 'x' })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: fmtUsd(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + fmtUsd(impliedOf(row, DATA.model)) + (impliedOf(row, DATA.model) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })
    ));
    var enrichmentBlock = enrichmentSection(row);
    if (enrichmentBlock) dialog.appendChild(enrichmentBlock);
    dialog.appendChild(rankContext(row));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    dialog.appendChild(farmSummary(row));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    var shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    shell.appendChild(controls());
    if (state.tab === 'pre-token') shell.appendChild(methodology());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') { shell.appendChild(modelPanel()); shell.appendChild(categoryBars()); shell.appendChild(categoryLeaders()); }
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    fillCategoryBreakdown();
    if (state.selected) openDetail(state.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
