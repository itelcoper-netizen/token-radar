// Token Radar page: renders the board from window.TOKEN_RADAR (written by
// main.ts as data.js), with search, category / chain filters, a watchlist
// toggle, five sort orders and a detail view for every protocol. Deep links:
// ?detail=<slug> opens a protocol, ?cat=<category>, ?chain=<chain>,
// ?watchlist=1 and ?q=<text> set the filters on load.

(function () {
  'use strict';
  var data = window.TOKEN_RADAR;
  if (!data) {
    document.getElementById('meta-line').textContent = 'No board data found (data.js did not load).';
    return;
  }
  var meta = data.meta;
  var rows = data.rows.slice();

  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(window.location.search);

  /** $1,234,567,890 -> $1.23B; $45,600,000 -> $45.6M; $12,300 -> $12.3K. */
  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n === null || n === undefined) return { text: '—', cls: 'flat' };
    var sign = n > 0 ? '+' : '';
    return { text: sign + n.toFixed(1) + '%', cls: n > 0 ? 'up' : n < 0 ? 'down' : 'flat' };
  }
  function ageText(days) {
    if (days === null || days === undefined) return '—';
    if (days < 365) return days + 'd';
    return (days / 365).toFixed(1) + 'y';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- header, stats, footer -------------------------------------------------
  $('meta-line').textContent =
    'Snapshot ' + meta.as_of + ' · ' + meta.tracked + ' protocols tracked · ' +
    meta.pre_token + ' pre-token · ' + meta.live_token + ' live-token set aside';
  var topValue = rows.length ? rows[0].implied_value_usd : 0;
  var stats = [
    { v: String(meta.board_rows), l: 'protocols ranked' },
    { v: String(meta.watchlist), l: 'on the watchlist' },
    { v: String(meta.pre_token), l: 'pre-token in total' },
    { v: String(meta.live_token), l: 'live-token set aside' },
    { v: money(topValue), l: 'top implied value', hot: true },
  ];
  $('stats').innerHTML = stats.map(function (s) {
    return '<div class="stat' + (s.hot ? ' hot' : '') + '"><b>' + esc(s.v) + '</b><span>' + esc(s.l) + '</span></div>';
  }).join('');
  $('method').textContent =
    'Model ' + meta.model + ': implied value = TVL × the category multiple × a growth factor × an age factor × plausibility. ' +
    'The category multiple is the median market-cap-per-TVL of the live-token protocols in that category, read from this ' +
    'snapshot (global median ' + meta.global_multiple.toFixed(2) + '× where a category has fewer than three live tokens). ' +
    'Growth adds or subtracts the 7-day TVL change, capped at −40% to +80%. Age adds up to 25% for protocols that have run ' +
    'for years with no token. Plausibility is 1.00 for a standalone protocol, 0.50 for a versioned or wrapped product, and ' +
    '0.05 for a centralised exchange, bridge or liquid-staking wrapper, whose TVL is custodial or another token in disguise.';
  $('source-line').textContent = 'Data: ' + meta.source + '. Board floor: $' + meta.floor_usd.toLocaleString('en-US') + ' TVL.';

  // ---- filter controls -------------------------------------------------------
  var catSel = $('cat');
  var chainSel = $('chain');
  var categories = [];
  var chains = [];
  rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) === -1) categories.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) === -1) chains.push(c); });
  });
  categories.sort();
  chains.sort();
  categories.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o);
  });
  chains.forEach(function (c) {
    var o = document.createElement('option'); o.value = c; o.textContent = c; chainSel.appendChild(o);
  });

  var state = {
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    watchlist: params.get('watchlist') === '1',
    sort: params.get('sort') || 'rank',
    open: params.get('detail') || null,
  };
  $('q').value = state.q;
  catSel.value = state.cat;
  chainSel.value = state.chain;
  $('watchlist').checked = state.watchlist;
  $('sort').value = state.sort;

  var sorters = {
    rank: function (a, b) { return a.rank - b.rank; },
    tvl: function (a, b) { return b.tvl_usd - a.tvl_usd || a.rank - b.rank; },
    change: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0) || a.rank - b.rank; },
    age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0) || a.rank - b.rank; },
    name: function (a, b) { return a.name.localeCompare(b.name); },
  };

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watchlist && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    out.sort(sorters[state.sort] || sorters.rank);
    return out;
  }

  function renderRows() {
    var list = visibleRows();
    var tbody = $('rows');
    tbody.innerHTML = list.map(function (r) {
      var ch = pct(r.change_7d);
      var chainCell = r.chains.slice(0, 2).join(', ') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '');
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.open === r.slug ? ' class="open"' : '') + '>' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + '</b><span class="slug">' + esc(r.slug) + '</span>' +
        (r.watchlist ? '<span class="badge">WL</span>' : '') + '</td>' +
        '<td>' + esc(r.category || '—') + '</td>' +
        '<td>' + esc(chainCell) + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + ch.cls + '">' + ch.text + '</td>' +
        '<td class="num value">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td></tr>';
    }).join('');
    $('empty').hidden = list.length > 0;
    $('count').textContent = list.length + ' of ' + rows.length + ' protocols';
  }

  function renderDetail() {
    var box = $('detail');
    var row = null;
    if (state.open) {
      for (var i = 0; i < rows.length; i++) if (rows[i].slug === state.open) { row = rows[i]; break; }
    }
    if (!row) { box.hidden = true; box.innerHTML = ''; return; }
    var b = row.breakdown;
    var ch = pct(row.change_7d);
    box.innerHTML =
      '<button class="close" id="detail-close" type="button">Close</button>' +
      '<h2>' + esc(row.name) + '<span class="slug">' + esc(row.slug) + ' · rank #' + row.rank + '</span></h2>' +
      '<div class="chips">' +
      '<span class="chip">' + esc(row.category || 'No category') + '</span>' +
      (row.watchlist ? '<span class="chip wl">On the watchlist</span>' : '<span class="chip">Below the watchlist floor</span>') +
      '<span class="chip">' + esc(row.chains.join(' · ') || 'No chain listed') + '</span>' +
      '<span class="chip">TVL ' + money(row.tvl_usd) + '</span>' +
      '<span class="chip">7d <span class="' + ch.cls + '">' + ch.text + '</span></span>' +
      '<span class="chip">Listed ' + esc(row.listed_at || 'unknown') + ' (' + ageText(row.age_days) + ' old)</span>' +
      '<span class="chip">Records no token</span>' +
      '</div>' +
      '<p class="value-line">Implied token value <b>' + money(row.implied_value_usd) + '</b></p>' +
      '<p class="math">TVL ' + money(row.tvl_usd) + ' × category multiple ' + b.category_multiple.toFixed(3) + '× = ' + money(b.base_usd) +
      ' &nbsp;·&nbsp; growth ×' + b.growth_factor.toFixed(3) + ' &nbsp;·&nbsp; age ×' + b.age_factor.toFixed(3) +
      ' &nbsp;·&nbsp; plausibility ×' + b.plausibility.toFixed(2) + ' = ' + money(row.implied_value_usd) + '</p>' +
      '<p class="reason">Plausibility ' + b.plausibility.toFixed(2) + ' — ' + esc(b.plausibility_reason) + '.</p>' +
      '<h3>How to farm it</h3><ol>' +
      row.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol>';
    box.hidden = false;
    $('detail-close').addEventListener('click', function () { setOpen(null); });
    box.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }

  function setOpen(slug) {
    state.open = slug;
    var url = new URL(window.location.href);
    if (slug) url.searchParams.set('detail', slug); else url.searchParams.delete('detail');
    window.history.replaceState(null, '', url.toString());
    renderRows();
    renderDetail();
  }

  function rerender() { renderRows(); renderDetail(); }

  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderRows(); });
  catSel.addEventListener('change', function (e) { state.cat = e.target.value; renderRows(); });
  chainSel.addEventListener('change', function (e) { state.chain = e.target.value; renderRows(); });
  $('watchlist').addEventListener('change', function (e) { state.watchlist = e.target.checked; renderRows(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderRows(); });
  $('rows').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) setOpen(state.open === tr.getAttribute('data-slug') ? null : tr.getAttribute('data-slug'));
  });

  rerender();
})();
