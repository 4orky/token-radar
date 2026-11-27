// Token Radar's dashboard, rebuilt from scratch. It reads window.RADAR — the
// dataset main.ts writes beside dashboard/ — and renders the ranked board, a
// filterable table, and a per-protocol detail drawer carrying the model's own
// inputs and the protocol's farm plan. No network: every byte on screen is
// already in data.js.
(function dashboard() {
  "use strict";

  var RADAR = window.RADAR;
  if (!RADAR) return;
  var ENRICHMENTS = RADAR.enrichments || {};
  var root = document.getElementById("board");
  var view = {
    query: "",
    category: "all",
    chain: "all",
    tier: "all",
    onlyWatchlist: false,
    tab: "pre-token",
    sortKey: "implied",
    direction: -1,
    openSlug: null,
  };

  // Value tiers, largest implied value first, so the tier filter lists them in
  // the same order the board reads.
  var TIERS = ["flagship", "major", "notable", "emerging", "nascent"];

  /** Every chain the board's rows run on, sorted — derived from the rows, so a new chain lists itself. */
  var allChains = function () {
    var present = {};
    RADAR.rows.forEach(function (r) {
      (r.chains || []).forEach(function (c) {
        present[c] = true;
      });
    });
    return Object.keys(present).sort();
  };

  /** A row's value tier from its enrichment record; a row with none reads as nascent. */
  var tierOfRow = function (row) {
    var e = ENRICHMENTS[row.slug];
    if (e && e.value_tier) return e.value_tier;
    return "nascent";
  };

  /** Whether a row is one of the 40 watchlist protocols, by the slug list main.ts writes. */
  var onWatchlist = function (row) {
    var slugs = RADAR.watchlist_slugs || [];
    return slugs.indexOf(row.slug) > -1;
  };

  var moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

  var fmtMoney = function (n) {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    if (Math.abs(n) >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "K";
    return moneyFmt.format(n);
  };

  var fmtChange = function (n) {
    if (n === null || n === undefined || !isFinite(n)) return "n/a";
    return (n > 0 ? "+" : "") + n.toFixed(2) + "%";
  };

  var fmtAge = function (days) {
    if (days === null || days === undefined) return "unknown";
    if (days >= 365) return (days / 365).toFixed(1) + "y";
    return Math.max(0, Math.round(days)) + "d";
  };

  // The model, recomputed in the page from the snapshot figures, so the number
  // the page shows can be checked against the number board.json carries.
  var multipleFor = function (row) {
    var cal = RADAR.calibration;
    if (!cal) return row.category_multiple;
    var hit = cal.byCategory.find(function (c) { return c.category === (row.category || "Other"); });
    var fallback = cal.global;
    if (hit !== undefined) return hit.multiple;
    return fallback;
  };

  var impliedFor = function (row, model) {
    var raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, raw));
    var growthFactor = 1 + (growth / 100) * model.growth_weight;
    var ageDays = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity =
      Math.min(1, Math.max(model.maturity_floor, model.maturity_floor + model.maturity_range * (Math.log(1 + Math.max(ageDays, 0) / 365) / Math.log(4))));
    var chainCount = row.chains ? row.chains.length : 0;
    var chainMult = 1 + model.chain_step * Math.min(Math.max(chainCount - 1, 0), model.chain_max_steps);
    return Math.max(1, Math.round(row.tvl_usd * multipleFor(row) * growthFactor * maturity * chainMult));
  };

  /** Build an element: tag, attributes, then children (strings, nodes, or arrays of either). */
  var node = function (tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs != null) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "className") el.className = attrs[key];
        else if (key === "text") el.textContent = attrs[key];
        else if (key === "html") el.innerHTML = attrs[key];
        else if (key.slice(0, 2) === "on") el.addEventListener(key.slice(2), attrs[key]);
        else if (attrs[key] !== null && attrs[key] !== undefined) el.setAttribute(key, attrs[key]);
      });
    }
    var add = function (child) {
      if (child === null || child === undefined || child === false) return;
      if (Array.isArray(child)) child.forEach(add);
      else if (typeof child === "string") el.appendChild(document.createTextNode(child));
      else el.appendChild(child);
    };
    if (kids !== undefined) add(kids);
    return el;
  };

  // The farm plan is the same derivation main.ts writes to board.json: category,
  // chains, TVL and age decide the action, the capital, the hold and every cost
  // and time. No name is special-cased, and the rules below cover every
  // category the model knows, so the page's plan and the board's plan agree.
  var firstChain = function (p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : "its main chain";
  };

  var capitalBands = [
    [5e9, 250],
    [1e9, 150],
    [1e8, 100],
  ];

  var capitalFor = function (p) {
    var band = capitalBands.find(function (b) { return p.tvl_usd >= b[0]; });
    return band === undefined ? 50 : band[1];
  };

  var holdFor = function (age) {
    var fallback = 30;
    if (age === null || age === undefined) return fallback;
    if (age < 180) { return 60; }
    if (age < 365) { return 45; }
    return fallback;
  };

  var hasWord = function (category, words) {
    return words.some(function (w) {
      return category.indexOf(w) >= 0;
    });
  };

  var actionRules = [
    {
      test: function (c) { return hasWord(c, ["lend", "cdp", "collateral"]); },
      write: function (name, capital, chain) {
        return "Supply $" + capital + " of USDC to " + name + " on " + chain + " and keep the position open.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["dex", "yield", "leveraged farm"]); },
      write: function (name, capital, chain) {
        return "Provide $" + capital + " of liquidity to " + name + "'s main pool on " + chain + " and keep the position open.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["bridge"]); },
      write: function (name, capital, chain) {
        return "Bridge $" + capital + " of USDC to " + chain + " through " + name + " and use the bridged funds in its app.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["staking", "restak"]); },
      write: function (name, capital, chain) {
        return "Stake $" + capital + " of the chain's staking asset through " + name + " and keep the receipt.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["perpetual", "derivative"]); },
      write: function (name, capital, chain) {
        return "Deposit $" + capital + " of USDC as margin on " + name + " and open one small hedge.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["prediction"]); },
      write: function (name, capital, chain) {
        return "Fund $" + capital + " and place one market position on " + name + ".";
      },
    },
    {
      test: function (c) { return hasWord(c, ["curator", "allocator"]); },
      write: function (name, capital, chain) {
        return "Deposit $" + capital + " into a " + name + " vault on " + chain + " and keep the shares.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["stable"]); },
      write: function (name, capital, chain) {
        return "Mint or deposit $" + capital + " of the stable asset through " + name + " on " + chain + ".";
      },
    },
    {
      test: function (c) { return hasWord(c, ["rwa"]); },
      write: function (name, capital, chain) {
        return "Mint $" + capital + " of the protocol's yield asset on " + chain + " and hold it.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["insurance"]); },
      write: function (name, capital, chain) {
        return "Buy $" + capital + " of cover from " + name + " on " + chain + " and keep the policy.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["launchpad"]); },
      write: function (name, capital, chain) {
        return "Join " + name + "'s next launch on " + chain + " with $" + capital + " and hold the allocation.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["basis"]); },
      write: function (name, capital, chain) {
        return "Deposit $" + capital + " of USDC into " + name + "'s basis vault on " + chain + " and keep the shares.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["option"]); },
      write: function (name, capital, chain) {
        return "Deposit $" + capital + " of USDC into " + name + "'s vault on " + chain + " and keep the position open.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["nft"]); },
      write: function (name, capital, chain) {
        return "List or buy one item on " + name + " on " + chain + " and keep the activity on the same wallet.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["payment", "card"]); },
      write: function (name, capital, chain) {
        return "Spend $" + capital + " through " + name + " on " + chain + " and keep the receipts on the same wallet.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["privacy"]); },
      write: function (name, capital, chain) {
        return "Use $" + capital + " through " + name + "'s private flow on " + chain + " and keep the receipt.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["index"]); },
      write: function (name, capital, chain) {
        return "Buy $" + capital + " of the " + name + " index on " + chain + " and hold the shares.";
      },
    },
    {
      test: function (c) { return hasWord(c, ["ai"]); },
      write: function (name, capital, chain) {
        return "Use $" + capital + " of " + name + "'s agent or tool on " + chain + " and keep the activity on the same wallet.";
      },
    },
  ];

  var actionFor = function (p, capital, chain) {
    var c = (p.category || "").toLowerCase();
    for (var i = 0; i < actionRules.length; i++) {
      if (actionRules[i].test(c)) return actionRules[i].write(p.name, capital, chain);
    }
    return "Deposit $" + capital + " of USDC into " + p.name + " on " + chain + " and keep the position open.";
  };

  var weeklyRules = [
    { test: function (c) { return hasWord(c, ["perpetual", "derivative", "option"]); }, write: "open and close one small trade" },
    { test: function (c) { return hasWord(c, ["dex", "yield"]); }, write: "add or remove a little liquidity, or one swap" },
    { test: function (c) { return hasWord(c, ["lend", "cdp"]); }, write: "adjust the position, or borrow and repay a little" },
    { test: function (c) { return hasWord(c, ["bridge"]); }, write: "bridge a small amount back or forth" },
    { test: function (c) { return hasWord(c, ["prediction"]); }, write: "place one small market position" },
    { test: function (c) { return hasWord(c, ["staking", "restak"]); }, write: "restake the rewards, or stake a little more" },
    { test: function (c) { return hasWord(c, ["launchpad"]); }, write: "vote in a launch or check the new listings" },
  ];

  var weeklyFor = function (p) {
    var c = (p.category || "").toLowerCase();
    for (var i = 0; i < weeklyRules.length; i++) {
      if (weeklyRules[i].test(c)) return weeklyRules[i].write;
    }
    return "a deposit, a borrow, a swap or a vote";
  };

  var renderStep = function (step) {
    var s = step.text + " Cost: " + step.cost + ". Time: " + step.time + ".";
    if (s.length > 600) return s.slice(0, 596) + "...";
    if (s.length < 20) s += " Hold the position and check the protocol's own page.";
    return String(s);
  };

  var farmPlan = function (p) {
    var chain = firstChain(p);
    var stake = capitalFor(p);
    var hold = holdFor(p.age_days);
    var weekly = weeklyFor(p);
    var steps = [
      { text: "Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.", cost: "under $3 of gas for the first transaction", time: "5 minutes" },
      { text: actionFor(p, stake, chain), cost: "$" + stake + " of capital and about $" + (stake >= 150 ? 8 : 4) + " of gas", time: "15 minutes to set up" },
      { text: "Make one qualifying action each week, such as " + weekly + ".", cost: "about $2 of gas a week", time: "10 minutes a week" },
      { text: "Hold the position for at least " + hold + " days so the activity is counted in more than one snapshot.", cost: "the $" + stake + " stays in the position", time: hold + " days" },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: "no fee to check, and never pay to claim", time: "10 minutes" },
      { text: "Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.", cost: "nothing but the log", time: "5 minutes" },
    ];
    return steps.map(renderStep);
  };

  var readHash = function () {
    var hash = window.location.hash.replace(/^#/, "");
    if (hash.length === 0) return;
    var query = new URLSearchParams(hash);
    if (query.get("q")) view.query = query.get("q");
    if (query.get("p")) view.openSlug = query.get("p");
    if (query.get("category")) view.category = query.get("category");
    if (query.get("chain")) view.chain = query.get("chain");
    if (query.get("tier")) view.tier = query.get("tier");
    if (query.get("wl") === "1") view.onlyWatchlist = true;
  };

  var writeHash = function () {
    var query = new URLSearchParams();
    if (view.query) query.set("q", view.query);
    if (view.category !== "all") query.set("category", view.category);
    if (view.chain !== "all") query.set("chain", view.chain);
    if (view.tier !== "all") query.set("tier", view.tier);
    if (view.onlyWatchlist) query.set("wl", "1");
    if (view.openSlug) query.set("p", view.openSlug);
    var next = query.toString();
    if (next) window.history.replaceState(null, "", "#" + next);
    else window.history.replaceState(null, "", window.location.pathname + window.location.search);
  };

  var filteredRows = function () {
    var q = view.query.trim().toLowerCase();
    return RADAR.rows.filter(function (r) {
      if (view.category !== "all" && r.category !== view.category) return false;
      if (view.chain !== "all" && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (view.tier !== "all" && tierOfRow(r) !== view.tier) return false;
      if (view.onlyWatchlist && !onWatchlist(r)) return false;
      if (q === "") return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(" ")].join(" ").toLowerCase();
      return hay.indexOf(q) > -1;
    });
  };

  // How many rows survive the filters, and how many the watchlist holds, so the
  // count line under the controls always says what the filters are doing.
  var filterLine = function () {
    var shown = filteredRows().length;
    var total = RADAR.rows.length;
    var wl = (RADAR.watchlist_slugs || []).length;
    var activeFilters = [];
    if (view.category !== "all") activeFilters.push(view.category);
    if (view.chain !== "all") activeFilters.push(view.chain);
    if (view.tier !== "all") activeFilters.push(view.tier + " tier");
    if (view.onlyWatchlist) activeFilters.push("watchlist only");
    if (view.query.trim()) activeFilters.push('"' + view.query.trim() + '"');
    var parts = [shown + " of " + total + " rows shown"];
    if (activeFilters.length > 0) parts.push("(" + activeFilters.join(" + ") + ")");
    if (view.onlyWatchlist) parts.push("of " + wl + " watchlist protocols");
    return parts.join(" ");
  };

  var sortedRows = function (list) {
    var key = view.sortKey;
    return list.slice().sort(function (x, y) {
      var first, second;
      if (key === "name") { first = x.name.toLowerCase(); second = y.name.toLowerCase(); }
      else if (key === "tvl") { first = x.tvl_usd; second = y.tvl_usd; }
      else if (key === "growth") { first = x.change_7d === null ? -Infinity : x.change_7d; second = y.change_7d === null ? -Infinity : y.change_7d; }
      else if (key === "age") { first = x.age_days === null ? Infinity : x.age_days; second = y.age_days === null ? Infinity : y.age_days; }
      else { first = x.implied_value_usd; second = y.implied_value_usd; }
      if (first < second) return -view.direction;
      if (first > second) return view.direction;
      return x.slug < y.slug ? -1 : x.slug > y.slug ? 1 : 0;
    });
  };

  var topBar = function () {
    return node("header", { className: "top" }, [
      node("div", { className: "brand" }, [
        node("span", { className: "mark" }),
        node("span", { className: "brand-name", text: "Token Radar" }),
      ]),
      node("div", { className: "top-meta" }, [
        node("span", { text: "Snapshot " + RADAR.as_of }),
        node("span", { text: "DefiLlama protocol index" }),
        node("span", { text: RADAR.model_version + " model" }),
      ]),
    ]);
  };

  var intro = function () {
    return node("section", { className: "lede" }, [
      node("div", null, [
        node("h1", { text: RADAR.watchlist_size + " watchlist protocols, ranked by implied value" }),
        node("p", { text: "The watchlist is the floor: every protocol with at least $" + Math.round(RADAR.floor_usd / 1e6) + "M of TVL and no token on record. The early radar adds " + RADAR.early_size + " pre-token protocols below that floor. Implied value is a model, not a promise." }),
      ]),
      node("div", { className: "facts" }, [
        node("div", { className: "fact" }, [node("span", { text: "Watchlist covered" }), node("b", { text: RADAR.watchlist_size + " / " + RADAR.watchlist_size })]),
        node("div", { className: "fact" }, [node("span", { text: "Pre-token rows scored" }), node("b", { text: String(RADAR.board_size) })]),
        node("div", { className: "fact" }, [node("span", { text: "Early rows below the floor" }), node("b", { text: String(RADAR.early_size) })]),
        node("div", { className: "fact" }, [node("span", { text: "Live-token protocols set aside" }), node("b", { text: String(RADAR.live_size) })]),
      ]),
    ]);
  };

  var filterBar = function () {
    var categories = Array.from(new Set(RADAR.rows.map(function (r) { return r.category || "Other"; }))).sort();
    var chainList = allChains();
    var search = node("input", { type: "search", id: "q", placeholder: "Search name, category or chain", value: view.query, "aria-label": "Search the board" });
    search.addEventListener("input", function () { view.query = search.value; writeHash(); render(); });
    var categorySelect = node("select", { id: "category", "aria-label": "Filter by category" }, [
      node("option", { value: "all", text: "All categories" }),
      categories.map(function (c) { return node("option", { value: c, text: c, selected: c === view.category ? "selected" : null }); }),
    ]);
    categorySelect.addEventListener("change", function () { view.category = categorySelect.value; writeHash(); render(); });
    var chainSelect = node("select", { id: "chain", "aria-label": "Filter by chain" }, [
      node("option", { value: "all", text: "All chains" }),
      chainList.map(function (c) { return node("option", { value: c, text: c, selected: c === view.chain ? "selected" : null }); }),
    ]);
    chainSelect.addEventListener("change", function () { view.chain = chainSelect.value; writeHash(); render(); });
    var tierSelect = node("select", { id: "tier", "aria-label": "Filter by value tier" }, [
      node("option", { value: "all", text: "All tiers" }),
      TIERS.map(function (t) { return node("option", { value: t, text: t + " tier", selected: t === view.tier ? "selected" : null }); }),
    ]);
    tierSelect.addEventListener("change", function () { view.tier = tierSelect.value; writeHash(); render(); });
    var watchlistBox = node("input", { type: "checkbox", id: "watchlist-only", checked: view.onlyWatchlist ? "checked" : null, onchange: function () { view.onlyWatchlist = watchlistBox.checked; writeHash(); render(); } });
    var preBtn = node("button", { type: "button", "aria-pressed": view.tab === "pre-token" ? "true" : "false", text: "Pre-token", onclick: function () { view.tab = "pre-token"; render(); } });
    var liveBtn = node("button", { type: "button", "aria-pressed": view.tab === "live" ? "true" : "false", text: "Live token", onclick: function () { view.tab = "live"; render(); } });
    return node("div", { className: "controls" }, [
      node("div", { className: "field" }, [node("label", { for: "q", text: "Search" }), search]),
      node("div", { className: "field" }, [node("label", { for: "category", text: "Category" }), categorySelect]),
      node("div", { className: "field" }, [node("label", { for: "chain", text: "Chain" }), chainSelect]),
      node("div", { className: "field" }, [node("label", { for: "tier", text: "Value tier" }), tierSelect]),
      node("div", { className: "field" }, [node("span", { className: "sub", text: "Watchlist" }), node("label", { className: "check" }, [watchlistBox, "Watchlist only"])]),
      node("div", { className: "field" }, [node("span", { className: "sub", text: "Token status" }), node("div", { className: "tabs" }, [preBtn, liveBtn])]),
      node("span", { className: "count", text: view.tab === "pre-token" ? filterLine() : RADAR.live.length + " live-token protocols" }),
    ]);
  };

  var sortHead = function (key, label) {
    return node("th", { scope: "col" }, [
      node("button", { type: "button", onclick: function () { if (view.sortKey === key) view.direction = -view.direction; else { view.sortKey = key; view.direction = -1; } render(); } },
        [label, view.sortKey === key ? node("span", { "aria-hidden": "true", text: view.direction < 0 ? " v" : " ^" }) : null]),
    ]);
  };

  var boardTable = function () {
    var list = sortedRows(filteredRows());
    if (list.length === 0) { // nothing survived the filters
      return node("div", { className: "panel" }, [
        node("div", { className: "empty" }, [
          node("h2", { text: "No protocol matches that filter" }),
          node("p", { text: "Clear the search or pick another category to see the board again." }),
          node("button", { className: "button primary", type: "button", text: "Clear filters", onclick: function () { view.query = ""; view.category = "all"; view.chain = "all"; view.tier = "all"; view.onlyWatchlist = false; writeHash(); render(); } }),
        ]),
      ]);
    }
    var top = list[0].implied_value_usd || 1;
    var tbody = node("tbody");
    list.forEach(function (entry) {
      var growth = entry.change_7d === null ? "n/a" : fmtChange(entry.change_7d);
      var growthClass = entry.change_7d === null ? "" : entry.change_7d >= 0 ? "pos" : "neg";
      var rowEl = node("tr", {
        "data-selected": view.openSlug === entry.slug ? "true" : "false",
        tabindex: "0",
        onclick: function () { openDetail(entry.slug); },
        onkeydown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(entry.slug); } },
      }, [
        node("td", { className: "num", text: String(entry.rank) }),
        node("td", null, [
          node("div", { className: "name" }, [
            node("b", { text: entry.name }),
            node("span", { className: "sub", text: (entry.category || "Other") + " on " + (entry.chains && entry.chains.length ? entry.chains.slice(0, 2).join(", ") : "an unnamed chain") }),
          ]),
        ]),
        node("td", { className: "num", text: fmtMoney(entry.tvl_usd) }),
        node("td", { className: "num " + growthClass, text: growth }),
        node("td", { className: "num", text: fmtAge(entry.age_days) }),
        node("td", null, [
          node("div", { className: "implied" }, [
            node("div", { className: "bar", "aria-hidden": "true" }, [node("i", { style: "width:" + Math.max(3, Math.round((entry.implied_value_usd / top) * 100)) + "%" })]),
            node("span", { className: "num", text: fmtMoney(entry.implied_value_usd) }),
          ]),
        ]),
        node("td", null, [node("span", { className: "status", text: "no token" })]),
      ]);
      tbody.appendChild(rowEl);
    });
    return node("div", { className: "panel" }, [
      node("div", { className: "table-wrap" }, [
        node("table", null, [
          node("caption", { className: "sub", text: "Pre-token protocols, strongest implied value first. Select a row for its model and farm plan." }),
          node("thead", null, [
            node("tr", null, [
              sortHead("implied", "Rank"),
              sortHead("name", "Protocol"),
              sortHead("tvl", "TVL"),
              sortHead("growth", "7d"),
              sortHead("age", "Age"),
              sortHead("implied", "Implied value"),
              node("th", { scope: "col", text: "Token" }),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  };

  var liveTable = function () {
    var tbody = node("tbody");
    RADAR.live.forEach(function (r) {
      tbody.appendChild(node("tr", null, [
        node("td", { className: "num", text: "live" }),
        node("td", null, [
          node("div", { className: "name" }, [
            node("b", { text: r.name }),
            node("span", { className: "sub", text: (r.category || "Other") + " on " + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(", ") : "an unnamed chain") }),
          ]),
        ]),
        node("td", { className: "num", text: fmtMoney(r.tvl_usd) }),
        node("td", { className: "num " + (r.change_7d !== null && r.change_7d >= 0 ? "pos" : "neg"), text: fmtChange(r.change_7d) }),
        node("td", { className: "num", text: fmtMoney(r.mcap_usd) }),
        node("td", null, [node("span", { className: "status", text: "already trades" })]),
      ]));
    });
    return node("div", { className: "panel" }, [
      node("div", { className: "table-wrap" }, [
        node("table", null, [
          node("caption", { className: "sub", text: "Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking." }),
          node("thead", null, [
            node("tr", null, [
              node("th", { scope: "col", text: "Status" }),
              node("th", { scope: "col", text: "Protocol" }),
              node("th", { scope: "col", text: "TVL" }),
              node("th", { scope: "col", text: "7d" }),
              node("th", { scope: "col", text: "Market cap" }),
              node("th", { scope: "col", text: "Token" }),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ]);
  };

  // The methodology note, rendered between the controls and the board table so
  // the first screenshot shows the value model and the ranked rows together.
  // It states the formula in plain language: TVL, priced at the category
  // median, then growth, time with no token, and chain breadth. No protocol
  // name is hardcoded.
  var methodNote = function () {
    return node("section", { className: "panel model", id: "methodology", "aria-labelledby": "methodology-title" }, [
      node("h2", { id: "methodology-title", text: "How the ranking works" }),
      node("p", { text: "Implied value starts from a protocol's total value locked, priced at its category's median market cap per dollar of TVL, the median across that category's live-token protocols in this same snapshot. Seven-day growth nudges it up or down, longer running with no token counts as riper, and each extra chain adds a little. No protocol name is hardcoded: one formula scores every protocol." }),
    ]);
  };

  var modelSection = function () {
    var m = RADAR.model;
    var cal = RADAR.calibration;
    var ordered = cal ? cal.byCategory.slice().sort(function (a, b) { return b.multiple - a.multiple; }) : [];
    var calRows = ordered.map(function (c) {
      return node("tr", null, [
        node("td", { text: c.category }),
        node("td", { className: "num", text: c.multiple.toFixed(3) + "x" }),
        node("td", { className: "num", text: String(c.n) + " live" }),
      ]);
    });
    return node("section", { className: "panel model" }, [
      node("h2", { text: "How implied value is computed" }),
      node("p", { className: "sub", text: "Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked." }),
      node("div", { className: "formula" }, [
        "implied = round( tvl_usd x category multiple x (1 + clamp(change_7d, " + m.growth_floor + ", " + m.growth_cap + ") / 100 x " + m.growth_weight + ") x maturity x chain breadth )",
      ]),
      node("p", { className: "sub", text: "The category multiple is calibrated on this snapshot: the median market cap per dollar of TVL of the live-token protocols in that line of business (at least " + m.multiple_min_samples + " of them; otherwise the global median of " + (cal ? cal.global.toFixed(3) : "n/a") + "x). Lending and staking trade near 0.1x of TVL, exchanges near 0.3x, bridges near 1x: one flat multiple would misprice them all." }),
      node("p", { className: "sub", text: "Maturity is 0.6 + 0.4 x ln(1 + age / 365) / ln(4), at most 1.0: a protocol a year in with no token scores 0.8, three years in scores 1.0. Chain breadth adds 3% a chain, up to 24%. Age is the time since the protocol was first listed; an unlisted age uses " + m.unknown_age_days + " days. The early radar is every pre-token protocol the exclusion rule keeps, whatever its TVL, and the live-token protocols are set aside with their market caps shown." }),
      node("h3", { text: "Calibration: market cap per dollar of TVL, from this snapshot" }),
      node("div", { className: "table-wrap" }, [
        node("table", { className: "cal" }, [
          node("thead", null, [
            node("tr", null, [
              node("th", { scope: "col", text: "Category" }),
              node("th", { scope: "col", text: "Multiple" }),
              node("th", { scope: "col", text: "Live protocols" }),
            ]),
          ]),
          node("tbody", null, calRows),
        ]),
      ]),
    ]);
  };

  var categoryTotals = function () {
    var sums = {};
    RADAR.rows.forEach(function (r) {
      var c = r.category || "Other";
      sums[c] = (sums[c] || 0) + r.implied_value_usd;
    });
    var ranked = Object.keys(sums).map(function (name) { return { c: name, v: sums[name] }; }).sort(function (x, y) { return y.v - x.v; }).slice(0, 6);
    var top = ranked.length ? ranked[0].v : 1;
    return node("section", { className: "panel model" }, [
      node("h2", { text: "Where the implied value sits" }),
      node("p", { className: "sub", text: "Total implied value by line of business, across the " + RADAR.board_size + " pre-token rows." }),
      node("div", { className: "catbars" }, ranked.map(function (item) {
        return node("div", { className: "catbar" }, [
          node("span", { className: "catname", text: item.c }),
          node("div", { className: "bar wide", "aria-hidden": "true" }, [node("i", { style: "width:" + Math.max(3, Math.round((item.v / top) * 100)) + "%" })]),
          node("span", { className: "num", text: fmtMoney(item.v) }),
        ]);
      })),
    ]);
  };

  // The category leaders: the single strongest protocol in each line of
  // business, by implied value, so a reader can see at a glance which name
  // leads lending, which leads bridges, and so on, without sorting the whole
  // board. The leader is the row with the largest implied value in its
  // category; ties are impossible, ranks are unique.
  var categoryLeaders = function () {
    var leaders = {};
    RADAR.rows.forEach(function (r) {
      var c = r.category || "Other";
      if (!leaders[c] || r.implied_value_usd > leaders[c].implied_value_usd) leaders[c] = r;
    });
    var ordered = Object.keys(leaders).map(function (c) { return leaders[c]; }).sort(function (x, y) { return y.implied_value_usd - x.implied_value_usd; });
    var top = ordered.length ? ordered[0].implied_value_usd : 1;
    return node("section", { className: "panel model" }, [
      node("h2", { text: "Category leaders" }),
      node("p", { className: "sub", text: "The strongest pre-token protocol in each line of business, by implied value. " + ordered.length + " categories, one leader each." }),
      node("div", { className: "catbars" }, ordered.map(function (r) {
        return node("div", { className: "catbar" }, [
          node("span", { className: "catname", text: (r.category || "Other") + ": " + r.name + " (#" + r.rank + ")" }),
          node("div", { className: "bar wide", "aria-hidden": "true" }, [node("i", { style: "width:" + Math.max(3, Math.round((r.implied_value_usd / top) * 100)) + "%" })]),
          node("span", { className: "num", text: fmtMoney(r.implied_value_usd) }),
        ]);
      })),
    ]);
  };

  /** One labelled value for the detail view's equation grid: a plain label and a bold figure. */
  var detailLine = function (label, value) {
    return node("div", null, [node("span", { text: label }), node("b", { className: "num", text: value })]);
  };

  // One sentence that reads a row's enrichment aloud: its tier, its maturity,
  // and how completely its record is documented, so the numbers above it have
  // a plain-language form.
  var enrichmentSentence = function (row, enrichment) {
    var band = enrichment.confidence_score >= 80 ? "well documented" : enrichment.confidence_score >= 60 ? "partly documented" : "thinly documented";
    var tierWord = enrichment.value_tier === "flagship" ? "one of the largest implied values on the board"
      : enrichment.value_tier === "major" ? "a large implied value"
      : enrichment.value_tier === "notable" ? "a mid-sized implied value"
      : enrichment.value_tier === "emerging" ? "a modest implied value"
      : "a small implied value";
    var ageWord = enrichment.maturity_label === "unknown age" ? "with no listing date on record"
      : "after running " + fmtAge(row.age_days) + " with no token";
    return row.name + " carries " + tierWord + " at " + fmtMoney(row.implied_value_usd) + ", " + ageWord +
      ", on " + enrichment.chain_count + " chain" + (enrichment.chain_count === 1 ? "" : "s") +
      ". Its record is " + band + " at " + enrichment.confidence_score + " out of 100, and its category holds " +
      (enrichment.category_context.pre_token_count || "n/a") + " pre-token protocols.";
  };

  // The enrichment block for one protocol's detail view: the confidence score,
  // the value tier, the maturity label, and the context of its category, each
  // with a plain label. The confidence score is a completeness read of the
  // row's own record, out of 100: a positive TVL is worth 35, a recorded
  // seven-day change 20, a known category 15, a listing date 15, and chain
  // breadth up to 15. The score describes the row; it never moves its rank.
  var enrichmentBlock = function (row) {
    var enrichment = ENRICHMENTS[row.slug];
    if (enrichment === undefined || enrichment === null) return null;
    var context = enrichment.category_context || {};
    var count = context.pre_token_count === undefined || context.pre_token_count === null ? "n/a" : String(context.pre_token_count);
    var total = context.total_tvl_usd === undefined || context.total_tvl_usd === null ? "n/a" : fmtMoney(context.total_tvl_usd);
    var medianTvl = context.median_tvl_usd === undefined || context.median_tvl_usd === null ? "n/a" : fmtMoney(context.median_tvl_usd);
    var benchmark = context.benchmark_multiple === undefined || context.benchmark_multiple === null ? "n/a" : String(context.benchmark_multiple) + "x";
    var samples = context.live_sample_count === undefined || context.live_sample_count === null ? "n/a" : String(context.live_sample_count);
    return node("section", { className: "detail-section" }, [
      node("h3", { text: "Enrichment" }),
      node("div", { className: "equation" }, [
        detailLine("Confidence score", String(enrichment.confidence_score) + " / 100"),
        detailLine("Value tier", enrichment.value_tier),
        detailLine("Maturity label", enrichment.maturity_label),
        detailLine("Chains", String(enrichment.chain_count)),
        detailLine("Protocols in this category", count),
        detailLine("Category total TVL", total),
        detailLine("Category median TVL", medianTvl),
        detailLine("Category benchmark multiple", benchmark),
      ]),
      node("p", { className: "sub", text: enrichmentSentence(row, enrichment) }),
      node("p", { className: "sub", text: "The benchmark multiple is the median market cap per dollar of TVL of the " + samples + " live-token protocol" + (samples === "1" ? "" : "s") + " in this category in the same snapshot, clamped to the model band of 0.05x to 1.5x. The tier is a reading aid only: flagship is $500M and up, major $100M, notable $25M, emerging $5M, and anything below that nascent." }),
    ]);
  };

  // The category breakdown lives outside the board shell, in the empty container
  // the page carries for it. It groups the pre-token rows by category and lists
  // each category with its protocol count and its total implied value, largest
  // total first, with a bar scaled to the largest category so the spread across
  // lines of business is visible at a glance.
  var fillBreakdown = function () {
    var host = document.getElementById("category-breakdown");
    if (host === null) return;
    host.textContent = "";
    var byCategory = {};
    RADAR.rows.forEach(function (r) {
      var c = r.category || "Other";
      if (!byCategory[c]) byCategory[c] = { category: c, count: 0, total: 0, topName: "", topValue: 0, values: [] };
      byCategory[c].count += 1;
      byCategory[c].total += r.implied_value_usd;
      byCategory[c].values.push(r.implied_value_usd);
      if (r.implied_value_usd > byCategory[c].topValue) { byCategory[c].topValue = r.implied_value_usd; byCategory[c].topName = r.name; }
    });
    var ordered = Object.keys(byCategory).map(function (key) {
      var item = byCategory[key];
      var sortedValues = item.values.slice().sort(function (x, y) { return x - y; });
      var half = Math.floor(sortedValues.length / 2);
      item.median = sortedValues.length % 2 === 1 ? sortedValues[half] : (sortedValues[half - 1] + sortedValues[half]) / 2;
      return item; // median attached above
    });
    ordered.sort(function (x, y) {
      if (y.total !== x.total) return y.total - x.total;
      return x.category < y.category ? -1 : x.category > y.category ? 1 : 0;
    });
    var top = ordered.length ? ordered[0].total : 1;
    var grand = ordered.reduce(function (sum, item) { return sum + item.total; }, 0);
    var heading = node("h2", { text: "Implied value by category" });
    var introLine = node("p", { className: "sub", text: "The " + RADAR.board_size + " pre-token rows grouped by line of business, largest total implied value first. Together they imply " + fmtMoney(grand) + " across " + ordered.length + " categories." });
    var wrap = node("div", { className: "catbars" }, ordered.map(function (item) {
      var pct = grand > 0 ? Math.round((item.total / grand) * 100) : 0;
      return node("div", { className: "catbar" }, [
        node("span", { className: "catname", text: item.category + " (" + item.count + " protocol" + (item.count === 1 ? "" : "s") + ", " + pct + "% of the board)" }),
        node("span", { className: "sub", text: "Largest: " + item.topName + " at " + fmtMoney(item.topValue) + " · median row " + fmtMoney(item.median) }),
        node("div", { className: "bar wide", "aria-hidden": "true" }, [node("i", { style: "width:" + Math.max(3, Math.round((item.total / top) * 100)) + "%" })]),
        node("span", { className: "num", text: fmtMoney(item.total) }),
      ]);
    }));
    host.appendChild(node("section", { className: "panel model" }, [heading, introLine, wrap]));
  };

  // The farm plan in one box: what it takes to farm this protocol, read off the
  // same figures the steps use. Capital and setup gas follow the TVL bands;
  // the weekly gas is $2 a week for the hold, so the gas over the hold is the
  // setup plus the weeks held.
  var farmBox = function (row) {
    var chain = firstChain(row);
    var stake = capitalFor(row);
    var hold = holdFor(row.age_days);
    var setupGas = stake >= 150 ? 8 : 4;
    var weekCount = Math.max(1, Math.ceil(hold / 7));
    var weeklyGas = 2 * weekCount;
    var gasTotal = setupGas + weeklyGas;
    return node("section", { className: "detail-section" }, [
      node("h3", { text: "What farming it takes" }),
      node("div", { className: "equation" }, [
        detailLine("Capital to commit", "$" + stake),
        detailLine("Setup gas", "about $" + setupGas),
        detailLine("Weekly gas", "about $2 a week"),
        detailLine("Hold", hold + " days (" + weekCount + " weeks)"),
        detailLine("Gas over the hold", "about $" + gasTotal),
        detailLine("Main chain", chain),
      ]),
      node("p", { className: "sub", text: "The capital stays in the position for the hold; the gas is the cost of the transactions. A fresh wallet holds only these funds, and the claim comes only from the link the protocol itself publishes." }),
    ]);
  };

  // Where this row sits on the board: its percentile, the median implied value
  // of its own category, and how far it is from the board's top row, so the
  // rank reads as a position, not just a number.
  var rankBox = function (row) {
    var top = RADAR.rows.filter(function (r) { return r.rank === 1; })[0];
    var same = RADAR.rows.filter(function (r) { return (r.category || "Other") === (row.category || "Other"); }).map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var half = Math.floor(same.length / 2);
    var medianValue = same.length % 2 === 1 ? same[half] : (same[half - 1] + same[half]) / 2;
    var percentile = Math.round(((RADAR.board_size - row.rank + 1) / RADAR.board_size) * 100);
    var topShare = top ? Math.round((row.implied_value_usd / top.implied_value_usd) * 100) : 0;
    return node("section", { className: "detail-section" }, [
      node("h3", { text: "Where this rank sits" }),
      node("p", { className: "sub", text: row.name + " is rank " + row.rank + " of " + RADAR.board_size + ", the top " + percentile + "% of the board. Its category median is " + fmtMoney(medianValue) + ", and it carries " + topShare + "% of the top row" + (top ? " (" + top.name + " at " + fmtMoney(top.implied_value_usd) + ")" : "") + "." }),
    ]);
  };

  var dialog = node("dialog", { className: "detail", id: "detail", "aria-labelledby": "detail-title" });
  dialog.addEventListener("close", function () { view.openSlug = null; writeHash(); });

  var openDetail = function (slug) {
    var row = RADAR.rows.filter(function (r) { return r.slug === slug; })[0];
    if (row === undefined) return;
    view.openSlug = slug; writeHash(); // remember the open protocol in the URL
    dialog.textContent = "";
    var steps = farmPlan(row);
    dialog.appendChild(node("div", { className: "detail-head" }, [
      node("div", null, [
        node("span", { className: "brand-name", text: "Rank " + row.rank + " of " + RADAR.board_size }),
        node("h2", { id: "detail-title", text: row.name }),
        node("p", { className: "sub", text: (row.category || "Other") + " on " + (row.chains && row.chains.length ? row.chains.join(", ") : "an unnamed chain") }),
      ]),
      node("button", { className: "close", type: "button", "aria-label": "Close details", text: "Close", onclick: function () { dialog.close(); } }),
    ]));
    dialog.appendChild(node("section", { className: "detail-section" }, [
      node("h3", { text: "Implied value" }),
      node("div", { className: "equation" }, [
        node("div", null, [node("span", { text: "TVL" }), node("b", { className: "num", text: fmtMoney(row.tvl_usd) })]),
        node("div", null, [node("span", { text: "Category multiple" }), node("b", { className: "num", text: String(row.category_multiple) + "x" })]),
        node("div", null, [node("span", { text: "Seven-day growth" }), node("b", { className: "num", text: fmtChange(row.change_7d) })]),
        node("div", null, [node("span", { text: "Age with no token" }), node("b", { className: "num", text: fmtAge(row.age_days) })]),
        node("div", null, [node("span", { text: "Growth multiplier" }), node("b", { className: "num", text: String(row.growth_multiplier) })]),
        node("div", null, [node("span", { text: "Maturity multiplier" }), node("b", { className: "num", text: String(row.maturity_multiplier) })]),
        node("div", null, [node("span", { text: "Chain breadth" }), node("b", { className: "num", text: String(row.chain_multiplier) + "x" })]),
        node("div", null, [node("span", { text: "Implied value" }), node("b", { className: "num", text: fmtMoney(row.implied_value_usd) })]),
      ]),
      node("p", { className: "sub", text: "Model " + RADAR.model_version + ": the same function scores every protocol. The page recomputes this row as " + fmtMoney(impliedFor(row, RADAR.model)) + (impliedFor(row, RADAR.model) === row.implied_value_usd ? ", the same number board.json carries." : ", which differs from the board: the data would be stale.") + " This is an estimate, not a price." }),
    ]));
    var enrichment = enrichmentBlock(row);
    if (enrichment) dialog.appendChild(enrichment);
    dialog.appendChild(rankBox(row));
    dialog.appendChild(node("section", { className: "detail-section" }, [
      node("h3", { text: "Farm plan" }),
      node("ol", { className: "steps" }, steps.map(function (s) {
        var cut = s.indexOf(" Cost: ");
        var action = cut < 0 ? s : s.slice(0, cut);
        var tail = cut < 0 ? "" : s.slice(cut + 1);
        return node("li", null, [node("b", { text: action }), node("span", { className: "cost", text: tail })]);
      })),
    ]));
    dialog.appendChild(farmBox(row));
    if (typeof dialog.showModal === "function" && dialog.open === false) {
      dialog.showModal();
    } else if (typeof dialog.showModal !== "function") {
      dialog.setAttribute("open", "");
    }
  };

  var render = function () {
    root.textContent = "";
    var shell = node("div", { className: "shell" });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filterBar());
    if (view.tab === "pre-token") shell.appendChild(methodNote());
    shell.appendChild(view.tab === "pre-token" ? boardTable() : liveTable());
    if (view.tab === "pre-token") { shell.appendChild(modelSection()); shell.appendChild(categoryTotals()); shell.appendChild(categoryLeaders()); }
    root.appendChild(shell);
    root.setAttribute("aria-busy", "false");
    if (!dialog.isConnected) root.appendChild(dialog);
    fillBreakdown();
    if (view.openSlug) openDetail(view.openSlug);
  };

  readHash(); render(); // boot: restore the URL state, then paint the page
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && dialog.open) dialog.close();
  });
})();
