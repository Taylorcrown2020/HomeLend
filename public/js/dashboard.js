/* dashboard.js — property search dashboard.
   Reads the borrower's submitted application (server, with sessionStorage
   fallback) and uses the SAME underwriting engine (calc.js + tx-tax.js) the
   application uses, so every home shows a real estimated payment, and selecting
   a home (or changing where you're looking) updates your DTI, monthly payment,
   and cash to close — then writes those changes back onto your application.

   SWAP POINTS for production:
     - Listings come from GET /api/listings (Market.fetchListings in
       market-data.js). Replace with a licensed MLS/IDX (RESO Web API) or
       aggregator (ATTOM, Bridge, RentCast) feed.
     - The map panel positions pins from sample lat/lng on a fixed Texas frame
       and resolves a clicked point to the nearest metro ZIP. Drop in
       Mapbox/Google Maps/MapLibre + a real geocoder for live geography.        */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var fmtUSD = function (n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); };
  var Calc = window.MortgageCalc, Tax = window.TxTax;

  var state = {
    app: null,            // submitted application snapshot (or null)
    saved: {},            // listingId -> listing  (saved set)
    authed: false,
    filters: { zip: '', minPrice: null, maxPrice: null, beds: null, minSqft: null, types: ['single_family', 'condo', 'multi_family', 'land'] },
    sort: 'price_asc',
    listings: [],
    photoIdx: {},         // listingId -> current photo index
    selectedId: null      // listing currently driving the numbers bar
  };

  /* ---- Fixed Texas frame so geography (and clicks) are stable ---- */
  var TXB = { minLng: -106.9, maxLng: -93.3, minLat: 25.5, maxLat: 36.8 };
  function fx(lng) { return (lng - TXB.minLng) / (TXB.maxLng - TXB.minLng); }
  function fy(lat) { return 1 - (lat - TXB.minLat) / (TXB.maxLat - TXB.minLat); }
  function lngAt(fX) { return TXB.minLng + fX * (TXB.maxLng - TXB.minLng); }
  function latAt(fY) { return TXB.minLat + (1 - fY) * (TXB.maxLat - TXB.minLat); }

  // Representative metro anchors: a clicked point resolves to the nearest one.
  var TX_ANCHORS = [
    { zip: '75201', lat: 32.78, lng: -96.80, label: 'Dallas' },
    { zip: '76104', lat: 32.75, lng: -97.33, label: 'Fort Worth' },
    { zip: '78701', lat: 30.27, lng: -97.74, label: 'Austin' },
    { zip: '78209', lat: 29.49, lng: -98.46, label: 'San Antonio' },
    { zip: '77002', lat: 29.76, lng: -95.37, label: 'Houston' },
    { zip: '79912', lat: 31.85, lng: -106.49, label: 'El Paso' },
    { zip: '75032', lat: 32.89, lng: -96.43, label: 'Rockwall' },
    { zip: '77479', lat: 29.60, lng: -95.63, label: 'Sugar Land' },
    { zip: '77550', lat: 29.30, lng: -94.80, label: 'Galveston' },
    { zip: '79401', lat: 33.58, lng: -101.85, label: 'Lubbock' },
    { zip: '78676', lat: 29.99, lng: -98.10, label: 'Wimberley' },
    { zip: '78401', lat: 27.80, lng: -97.40, label: 'Corpus Christi' },
    { zip: '79701', lat: 31.99, lng: -102.08, label: 'Midland' }
  ];
  function nearestAnchor(lat, lng) {
    var best = TX_ANCHORS[0], bd = Infinity;
    TX_ANCHORS.forEach(function (a) {
      var d = (a.lat - lat) * (a.lat - lat) + (a.lng - lng) * (a.lng - lng);
      if (d < bd) { bd = d; best = a; }
    });
    return best;
  }

  /* ---------- Boot ---------- */
  function boot() {
    wireFilters();
    wireSort();
    wireLightbox();
    wireMapModal();
    $('logoutBtn').addEventListener('click', logout);
    $('mapExpandBtn').addEventListener('click', openMapModal);
    window.addEventListener('resize', positionBar);
    Promise.all([loadApplication(), loadSaved(), loadMe()]).then(function () {
      hydrateFromApp();
      applyQualifiedRange();
      refresh();
    });
  }

  function loadMe() {
    return fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.user) {
          state.authed = true;
          $('whoami').textContent = j.user.email;
          $('logoutBtn').style.display = '';
        }
      }).catch(function () {});
  }

  function loadApplication() {
    return fetch('/api/application', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { application: null }; })
      .then(function (j) {
        if (j && j.application) { state.app = j.application; return; }
        try { var p = sessionStorage.getItem('ks_app_preview'); if (p) state.app = JSON.parse(p); } catch (e) {}
      }).catch(function () {
        try { var p = sessionStorage.getItem('ks_app_preview'); if (p) state.app = JSON.parse(p); } catch (e) {}
      });
  }

  function loadSaved() {
    return fetch('/api/saved', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { saved: [] }; })
      .then(function (j) {
        (j.saved || []).forEach(function (s) { state.saved[String(s.listingId)] = s.data; });
      }).catch(function () {});
  }

  /* Pull saved shopping context off the application: where you were looking
     last and which home you had selected. */
  function hydrateFromApp() {
    var a = state.app; if (!a) return;
    var ctx = a.context || {};
    var z = ctx.lookingZip || (a.profile && a.profile.lookingZip);
    if (z && /^\d{5}$/.test(z)) {
      state.filters.zip = z;
      if ($('zipInput')) $('zipInput').value = z;
    }
    if (ctx.selectedListingId) state.selectedId = String(ctx.selectedListingId);
  }

  /* ---------- Underwriting basis from the application ---------- */
  function defaultRateFor(program, term, credit) {
    if (!window.MarketData) return 6.75;
    var g = window.MarketData.rateGrid(program || 'conventional', term || 30, credit || 0);
    return g.rows[2].rate;
  }
  function basis() {
    var loan = (state.app && state.app.loan) || {};
    var program = loan.program || 'conventional';
    var term = loan.termYears || 30;
    return {
      program: program,
      downPaymentPct: loan.downPaymentPct != null ? loan.downPaymentPct : 5,
      interestRate: loan.interestRate || defaultRateFor(program, term, loan.creditScore || 0),
      termYears: term,
      creditScore: loan.creditScore || 0,
      grossMonthlyIncome: loan.grossMonthlyIncome || 0,
      monthlyDebts: loan.monthlyDebts || 0,
      vaUse: loan.vaUse || 'first',
      vaFundingFeeExempt: loan.vaFundingFeeExempt || false,
      dpaAmount: loan.dpaAmount || 0,
      firstTimeBuyer: loan.firstTimeBuyer || false
    };
  }
  // Tax context for wherever you're currently looking.
  function taxContext() {
    var z = state.filters.zip;
    if (z && /^\d{5}$/.test(z) && Tax) {
      var e = Tax.estimate(z);
      return { zip: z, ratePct: e.ratePct, county: e.county, source: e.source };
    }
    var a = state.app;
    if (a && a.loan && a.loan.taxRatePct) {
      return { zip: (a.profile && a.profile.lookingZip) || null, ratePct: a.loan.taxRatePct, county: a.taxCounty || null, source: 'application' };
    }
    return { zip: null, ratePct: Tax ? Tax.STATEWIDE_DEFAULT : 1.8, county: null, source: 'statewide' };
  }
  function hasIncome() { return basis().grossMonthlyIncome > 0; }
  // Estimate every figure for a specific home using the borrower's basis + the
  // tax rate where they're looking.
  function computeFor(listing) {
    if (!Calc) return null;
    var b = basis();
    var tx = taxContext();
    var downPct = b.downPaymentPct;
    if (listing.type === 'land' && downPct < 20) downPct = 20; // land floor
    var p = Object.assign({}, b, {
      downPaymentPct: downPct,
      purchasePrice: listing.price,
      taxRatePct: tx.ratePct,
      hoaMonthly: listing.hoa || 0
    });
    return Calc.calculate(p);
  }
  function maxBackFor(program) {
    return ({ fha: 56.9, va: 60, usda: 43, conventional: 50, conventional_fthb: 50, jumbo: 43, land: 43 })[program] || 50;
  }

  /* ---------- Qualified range banner + price clamp ---------- */
  function applyQualifiedRange() {
    var banner = $('qualBanner');
    if (!state.app) {
      banner.innerHTML = '<div class="qual" style="background:var(--gold-50);color:var(--gold)">' +
        'No application found — showing all listings. <a href="/apply.html" style="color:inherit;text-decoration:underline;margin-left:4px">Start your application</a> to filter by what you qualify for.</div>';
      return;
    }
    var maxQ = Math.round(state.app.maxQualifiedPrice || 0);
    var prog = (state.app.program || 'conventional');
    var progLabel = prog.replace(/_/g, ' ');
    if (maxQ > 0) {
      state.filters.maxPrice = maxQ;
      $('maxPrice').value = maxQ;
      $('maxHint').textContent = '· qualified up to ' + fmtUSD(maxQ);
      banner.innerHTML = '<div class="qual">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"/></svg>' +
        'Pre-qualified up to <strong style="margin:0 4px">' + fmtUSD(maxQ) + '</strong> on a ' + progLabel + ' loan</div>';
    }
    maybeLandNote();
  }
  function maybeLandNote() {
    if (state.filters.types.indexOf('land') !== -1) $('mapNote').dataset.land = '1';
  }

  /* ---------- Your numbers bar ---------- */
  function dtiTag(val, kind, maxBack) {
    var cls = 'good';
    if (kind === 'front') cls = val <= 28 ? 'good' : val <= 36 ? 'warn' : 'bad';
    else cls = val <= maxBack * 0.75 ? 'good' : val <= maxBack ? 'warn' : 'bad';
    return '<span class="tag ' + cls + '">' + cls.toUpperCase() + '</span>';
  }
  function renderNumbar() {
    var el = $('ksNumberBar');
    if (!el || !window.KSNumberBar) return;
    var tx = taxContext();
    var selected = state.selectedId ? findListing(state.selectedId) : null;
    var scenario = selected;
    if (!scenario && state.app && state.app.loan && state.app.loan.purchasePrice) {
      scenario = { id: '__app__', price: state.app.loan.purchasePrice, hoa: state.app.loan.hoaMonthly || 0,
        title: 'your target price', type: state.app.loan.program === 'land' ? 'land' : 'single_family' };
    }
    if (!state.app && !selected) {
      KSNumberBar.render(el, { prompt: 'Estimated payments use standard assumptions. <a href="/apply.html">Finish your application</a> to see your DTI, cash to close, and what you qualify for.' });
      positionBar();
      return;
    }
    var r = scenario ? computeFor(scenario) : null;
    if (!r) { KSNumberBar.hide(el); positionBar(); return; }

    var areaLabel = tx.county ? (tx.county + ' Co.') : (tx.zip || 'TX');
    var ctxLabel = selected
      ? ('<b>' + escapeHtml(selected.title) + '</b> · ' + fmtUSD(selected.price))
      : ('Target price ' + fmtUSD(scenario.price));

    KSNumberBar.render(el, {
      program: basis().program,
      contextLabel: ctxLabel,
      taxLabel: tx.ratePct + '% (' + areaLabel + ')',
      income: hasIncome(),
      numbers: { totalMonthly: r.totalMonthly, frontDTI: r.frontDTI, backDTI: r.backDTI, ltv: r.ltv, cashToClose: r.cashToClose },
      qualifiedUpTo: (state.app && state.app.maxQualifiedPrice) || null,
      clear: selected ? function () { selectListing(null); } : null
    });
    positionBar();
  }
  function positionBar() {
    if (window.KSNumberBar) KSNumberBar.position($('ksNumberBar'), 'nav.nav', document.querySelector('.filterbar'));
  }

  /* ---------- Filtering / fetching ---------- */
  function buildQuery() {
    var f = state.filters, p = [];
    if (f.minPrice) p.push('minPrice=' + f.minPrice);
    if (f.maxPrice) p.push('maxPrice=' + f.maxPrice);
    if (f.beds) p.push('beds=' + f.beds);
    if (f.minSqft) p.push('minSqft=' + f.minSqft);
    if (f.zip && /^\d{5}$/.test(f.zip)) p.push('zip=' + f.zip);
    if (f.types && f.types.length) p.push('types=' + f.types.join(','));
    return p.length ? '?' + p.join('&') : '';
  }
  function refresh() {
    $('countLine').textContent = 'Loading listings…';
    fetch('/api/listings' + buildQuery(), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.listings) { state.listings = j.listings; }
        else { state.listings = clientFilter(window.MarketData.fetchListings({})); }
        afterListings();
      }).catch(function () {
        state.listings = clientFilter(window.MarketData.fetchListings({}));
        afterListings();
      });
  }
  function afterListings() {
    // Drop a selection that's no longer in view.
    if (state.selectedId && !findListing(state.selectedId)) state.selectedId = null;
    render();
    renderNumbar();
  }
  function clientFilter(all) {
    var f = state.filters;
    return all.filter(function (p) {
      if (f.minPrice && p.price < f.minPrice) return false;
      if (f.maxPrice && p.price > f.maxPrice) return false;
      if (f.beds && p.beds < f.beds) return false;
      if (f.minSqft && p.sqft < f.minSqft) return false;
      if (f.types && f.types.length && f.types.indexOf(p.type) === -1) return false;
      if (f.zip && /^\d{5}$/.test(f.zip) && p.zip !== f.zip) return false;
      return true;
    });
  }
  function sortListings(arr) {
    var s = state.sort, a = arr.slice();
    a.sort(function (x, y) {
      if (s === 'price_asc') return x.price - y.price;
      if (s === 'price_desc') return y.price - x.price;
      if (s === 'sqft_desc') return y.sqft - x.sqft;
      if (s === 'rating_desc') return y.rating - x.rating;
      return 0;
    });
    return a;
  }
  function findListing(id) {
    id = String(id);
    for (var i = 0; i < state.listings.length; i++) if (String(state.listings[i].id) === id) return state.listings[i];
    return null;
  }

  /* ---------- Render ---------- */
  function render() {
    var arr = sortListings(state.listings);
    var cards = $('cards');
    var where = state.filters.zip ? (' in ' + areaName()) : ' across Texas';
    $('countLine').textContent = arr.length.toLocaleString() + ' home' + (arr.length === 1 ? '' : 's') + ' available' + where;
    $('areaTitle').textContent = state.filters.zip ? ('Homes in ' + areaName()) : 'Texas Homes for Sale';

    if (!arr.length) {
      cards.innerHTML = '<div class="empty"><h3 style="margin-bottom:6px">No matches in this range</h3>' +
        '<p>Try a different area on the map, or widen your price range or property types.</p></div>';
      renderMap([]);
      return;
    }
    cards.innerHTML = arr.map(cardHTML).join('');
    arr.forEach(wireCard);
    renderMap(arr);
  }
  function areaName() {
    var tx = taxContext();
    if (tx.county) return tx.county + ' County';
    return state.filters.zip || 'Texas';
  }
  function typeLabel(t) {
    return ({ single_family: 'Single-family', condo: 'Condo', multi_family: 'Multi-family', land: 'Land' })[t] || t;
  }
  function cardHTML(p) {
    var saved = !!state.saved[String(p.id)];
    var isSel = String(p.id) === String(state.selectedId);
    var pi = state.photoIdx[p.id] || 0;
    var photos = p.photos || [];
    var dots = photos.map(function (_, i) { return '<i class="' + (i === pi ? 'on' : '') + '"></i>'; }).join('');
    var landNote = p.type === 'land' ? '<div class="muted" style="font-size:12px;margin-top:6px">Requires 20% down</div>' : '';
    var r = computeFor(p);
    var est = r ? '<span class="est">Est. <b>' + fmtUSD(r.totalMonthly) + '</b>/mo</span>' :
      '<span class="est">—</span>';
    var selLabel = isSel ? 'Selected ✓' : 'Use these numbers';
    var rateBadge = p.rating ? '<div class="rate"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1z"/></svg>' + (p.rating || 0).toFixed(1) + '</div>' : '';
    return '' +
      '<article class="pc' + (isSel ? ' selected' : '') + '" data-id="' + p.id + '">' +
        '<div class="ph" data-photo>' +
          '<img src="' + (photos[pi] || '') + '" alt="' + escapeHtml(p.title) + '">' +
          rateBadge +
          '<div class="typetag">' + typeLabel(p.type) + '</div>' +
          (photos.length > 1 ? '<div class="dots">' + dots + '</div>' : '') +
        '</div>' +
        '<div class="body" data-select>' +
          '<div class="row1"><div class="name">' + escapeHtml(p.title) + '</div><div class="price">' + fmtUSD(p.price) + '</div></div>' +
          '<div class="addr">' + escapeHtml(p.address) + ', ' + escapeHtml(p.city) + ' ' + p.zip + '</div>' +
          landNote +
          '<div class="chips">' +
            chip(bedIcon(), (p.beds || 0) + ' Bed' + (p.beds === 1 ? '' : 's')) +
            chip(bathIcon(), (p.baths || 0) + ' Bath' + (p.baths === 1 ? '' : 's')) +
            chip(rulerIcon(), (p.sqft || 0).toLocaleString() + ' ft²') +
            '<button class="heart' + (saved ? ' saved' : '') + '" data-heart title="Save">' + heartIcon() + '</button>' +
          '</div>' +
          '<div class="payrow">' + est +
            '<button class="selbtn" data-select-btn>' + selLabel + '</button>' +
          '</div>' +
        '</div>' +
      '</article>';
  }
  function chip(ico, txt) { return '<span class="chip">' + ico + txt + '</span>'; }
  function bedIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M3 14h18M7 10V8a1 1 0 0 1 1-1h3v3"/></svg>'; }
  function bathIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 12h16v3a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM6 12V6a2 2 0 0 1 2-2 2 2 0 0 1 2 2"/></svg>'; }
  function rulerIcon() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 7h18v10H3zM7 7v3M11 7v4M15 7v3M19 7v4"/></svg>'; }
  function heartIcon() { return '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-4.5-9.5-9C1 9 2.5 5.5 6 5.5c2 0 3.2 1.2 4 2.3.8-1.1 2-2.3 4-2.3 3.5 0 5 3.5 3.5 6.5C19 16.5 12 21 12 21z"/></svg>'; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  function wireCard(p) {
    var el = document.querySelector('.pc[data-id="' + p.id + '"]');
    if (!el) return;
    el.querySelector('[data-heart]').addEventListener('click', function (e) { e.stopPropagation(); toggleSave(p, this); });
    var ph = el.querySelector('[data-photo]');
    ph.addEventListener('click', function (e) { e.stopPropagation(); openLightbox(p); });
    el.querySelector('[data-select-btn]').addEventListener('click', function (e) {
      e.stopPropagation();
      selectListing(String(p.id) === String(state.selectedId) ? null : p.id);
    });
    el.querySelector('[data-select]').addEventListener('click', function () {
      if (String(p.id) !== String(state.selectedId)) selectListing(p.id);
    });
    if ((p.photos || []).length > 1) {
      ph.addEventListener('mousemove', function (e) {
        var rect = ph.getBoundingClientRect();
        var frac = (e.clientX - rect.left) / rect.width;
        var idx = Math.min(p.photos.length - 1, Math.max(0, Math.floor(frac * p.photos.length)));
        if (idx !== (state.photoIdx[p.id] || 0)) {
          state.photoIdx[p.id] = idx;
          ph.querySelector('img').src = p.photos[idx];
          ph.querySelectorAll('.dots i').forEach(function (d, i) { d.className = i === idx ? 'on' : ''; });
        }
      });
    }
  }

  /* ---------- Selecting a home → drives the numbers + persists ---------- */
  function selectListing(id) {
    state.selectedId = id ? String(id) : null;
    document.querySelectorAll('.pc').forEach(function (el) {
      var on = el.dataset.id === state.selectedId;
      el.classList.toggle('selected', on);
      var b = el.querySelector('[data-select-btn]');
      if (b) b.textContent = on ? 'Selected ✓' : 'Use these numbers';
    });
    renderNumbar();
    persistContext();
  }

  /* ---------- Save / unsave ---------- */
  function toggleSave(p, btn) {
    var id = String(p.id), isSaved = !!state.saved[id];
    if (isSaved) {
      delete state.saved[id]; btn.classList.remove('saved');
      fetch('/api/saved/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' }).catch(function () {});
    } else {
      state.saved[id] = p; btn.classList.add('saved');
      fetch('/api/saved', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ listing: p })
      }).then(function (r) { if (r.status === 401) window.location.href = '/portal.html'; }).catch(function () {});
    }
  }

  /* ---------- Persist shopping context back onto the application ---------- */
  var persistTimer = null;
  function persistContext() {
    var tx = taxContext();
    var selected = state.selectedId ? findListing(state.selectedId) : null;
    var r = null;
    if (selected) r = computeFor(selected);
    else if (state.app && state.app.loan && state.app.loan.purchasePrice) {
      r = computeFor({ price: state.app.loan.purchasePrice, hoa: state.app.loan.hoaMonthly || 0, type: state.app.loan.program === 'land' ? 'land' : 'single_family' });
    }
    var context = {
      lookingZip: tx.zip || null,
      taxRatePct: tx.ratePct,
      taxCounty: tx.county || null,
      selectedListingId: selected ? String(selected.id) : null,
      selectedListing: selected ? { id: selected.id, title: selected.title, address: selected.address, city: selected.city, zip: selected.zip, price: selected.price, type: selected.type } : null,
      numbers: r ? {
        price: r.price, totalMonthly: r.totalMonthly, pi: r.pi, monthlyTax: r.monthlyTax,
        monthlyInsurance: r.monthlyInsurance, monthlyMI: r.monthlyMI,
        frontDTI: r.frontDTI, backDTI: r.backDTI, ltv: r.ltv, cashToClose: r.cashToClose
      } : null,
      updatedAt: new Date().toISOString()
    };

    // keep the offline preview in sync too
    try {
      if (state.app) {
        state.app.context = Object.assign({}, state.app.context, context);
        sessionStorage.setItem('ks_app_preview', JSON.stringify(state.app));
      }
    } catch (e) {}

    if (!state.authed) return; // nothing to write server-side
    clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      fetch('/api/application/context', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ context: context })
      }).catch(function () {});
    }, 400);
  }

  /* ---------- Where you're looking → tax + listings ---------- */
  function setLookingZip(zip, opts) {
    opts = opts || {};
    zip = String(zip || '').trim();
    state.filters.zip = zip;
    if ($('zipInput')) $('zipInput').value = zip;
    markActive();
    refresh();          // new houses + map
    persistContext();   // new zip + tax rate onto the application
    if (opts.closeModal) closeMapModal();
  }

  /* ---------- Inline map panel (fixed Texas frame, clamped pins) ---------- */
  function renderMap(arr) {
    var map = $('map');
    map.querySelectorAll('.pin').forEach(function (n) { n.remove(); });
    if (!arr.length) return;
    arr.slice(0, 24).forEach(function (p) {
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      var x = clampPct(fx(p.lng) * 100);
      var y = clampPct(fy(p.lat) * 100);
      var pin = document.createElement('div');
      pin.className = 'pin' + (String(p.id) === String(state.selectedId) ? ' active' : '');
      pin.style.left = x + '%'; pin.style.top = y + '%';
      pin.textContent = priceShort(p.price);
      pin.addEventListener('click', function () { selectListing(p.id); });
      pin.addEventListener('mouseenter', function () { var c = document.querySelector('.pc[data-id="' + p.id + '"]'); if (c) c.style.boxShadow = 'var(--shadow-lg)'; });
      pin.addEventListener('mouseleave', function () { var c = document.querySelector('.pc[data-id="' + p.id + '"]'); if (c) c.style.boxShadow = ''; });
      map.appendChild(pin);
    });
  }
  function clampPct(v) { return Math.max(4, Math.min(96, v)); }
  function priceShort(n) {
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(n / 1000) + 'k';
  }

  /* ---------- Expanded, draggable map ---------- */
  var view = { cx: 0.5, cy: 0.5, zoom: 1 };
  function openMapModal() {
    // center on where we're looking, if known
    var tx = taxContext();
    var a = tx.zip ? nearestAnchorByZip(tx.zip) : null;
    if (a) { view = { cx: fx(a.lng), cy: fy(a.lat), zoom: 2.4 }; }
    else { view = { cx: 0.5, cy: 0.5, zoom: 1 }; }
    $('mapModal').classList.add('open');
    requestAnimationFrame(renderBigMap);
    updateMapFoot();
  }
  function nearestAnchorByZip(zip) {
    for (var i = 0; i < TX_ANCHORS.length; i++) if (TX_ANCHORS[i].zip === zip) return TX_ANCHORS[i];
    var l = findListing && state.listings.filter(function (x) { return x.zip === zip; })[0];
    return l ? { lat: l.lat, lng: l.lng, zip: zip } : null;
  }
  function closeMapModal() { $('mapModal').classList.remove('open'); }

  function wrapSize() { var w = $('bigMapWrap'); return { W: w.clientWidth, H: w.clientHeight }; }
  function toScreen(fX, fY) {
    var s = wrapSize();
    return { x: s.W / 2 + (fX - view.cx) * s.W * view.zoom, y: s.H / 2 + (fY - view.cy) * s.H * view.zoom };
  }
  function toFrac(px, py) {
    var s = wrapSize();
    return { fx: view.cx + (px - s.W / 2) / (s.W * view.zoom), fy: view.cy + (py - s.H / 2) / (s.H * view.zoom) };
  }
  function renderBigMap() {
    var big = $('bigMap'); if (!big) return;
    var s = wrapSize();
    // background motion: where does the TX frame origin (0,0) land on screen?
    var o = toScreen(0, 0), far = toScreen(1, 1);
    big.style.backgroundPosition = o.x + 'px ' + o.y + 'px';
    var cell = Math.max(18, ((far.x - o.x) / (TXB.maxLng - TXB.minLng))); // ~px per degree lng
    big.style.backgroundSize = (cell) + 'px ' + (cell) + 'px';

    big.querySelectorAll('.pin,.citylab').forEach(function (n) { n.remove(); });
    // metro labels for orientation
    TX_ANCHORS.forEach(function (a) {
      var pt = toScreen(fx(a.lng), fy(a.lat));
      if (pt.x < -60 || pt.x > s.W + 60 || pt.y < -30 || pt.y > s.H + 30) return;
      var lab = document.createElement('div');
      lab.className = 'citylab';
      lab.style.left = pt.x + 'px'; lab.style.top = (pt.y - 14) + 'px';
      lab.textContent = a.label;
      big.appendChild(lab);
    });
    // listing pins
    state.listings.slice(0, 60).forEach(function (p) {
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      var pt = toScreen(fx(p.lng), fy(p.lat));
      if (pt.x < -40 || pt.x > s.W + 40 || pt.y < -40 || pt.y > s.H + 40) return;
      var pin = document.createElement('div');
      pin.className = 'pin' + (String(p.id) === String(state.selectedId) ? ' active' : '');
      pin.style.left = pt.x + 'px'; pin.style.top = pt.y + 'px';
      pin.textContent = priceShort(p.price);
      pin.addEventListener('click', function (e) { e.stopPropagation(); selectListing(p.id); setLookingZip(p.zip, { closeModal: true }); });
      big.appendChild(pin);
    });
  }
  function updateMapFoot() {
    var info = $('mapFootInfo');
    var c = toFrac(wrapSize().W / 2, wrapSize().H / 2);
    var a = nearestAnchor(latAt(c.fy), lngAt(c.fx));
    var e = Tax ? Tax.estimate(a.zip) : { ratePct: '—', county: a.label };
    info.innerHTML = 'Centered near <b>' + a.label + '</b> · ZIP ' + a.zip + ' · tax ~' + e.ratePct + '%';
  }
  function wireMapModal() {
    $('mapModalClose').addEventListener('click', closeMapModal);
    $('mapModal').addEventListener('click', function (e) { if (e.target === this) closeMapModal(); });
    document.addEventListener('keydown', function (e) {
      if ($('mapModal').classList.contains('open') && e.key === 'Escape') closeMapModal();
    });
    $('mapZoomIn').addEventListener('click', function () { zoomBy(1.4); });
    $('mapZoomOut').addEventListener('click', function () { zoomBy(1 / 1.4); });
    $('mapReset').addEventListener('click', function () { view = { cx: 0.5, cy: 0.5, zoom: 1 }; renderBigMap(); updateMapFoot(); });

    var wrap = $('bigMapWrap');
    wrap.addEventListener('wheel', function (e) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });

    var drag = null;
    function down(px, py) { drag = { px: px, py: py, moved: 0, cx: view.cx, cy: view.cy }; wrap.classList.add('grabbing'); }
    function move(px, py) {
      if (!drag) return;
      var s = wrapSize();
      var dx = px - drag.px, dy = py - drag.py;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      view.cx = drag.cx - dx / (s.W * view.zoom);
      view.cy = drag.cy - dy / (s.H * view.zoom);
      renderBigMap(); updateMapFoot();
    }
    function up(px, py) {
      if (!drag) return;
      var wasClick = drag.moved < 6;
      var startPx = drag.px, startPy = drag.py;
      drag = null; wrap.classList.remove('grabbing');
      if (wasClick) handleMapClick(startPx, startPy);
    }
    wrap.addEventListener('mousedown', function (e) { var r = wrap.getBoundingClientRect(); down(e.clientX - r.left, e.clientY - r.top); });
    window.addEventListener('mousemove', function (e) { if (!drag) return; var r = wrap.getBoundingClientRect(); move(e.clientX - r.left, e.clientY - r.top); });
    window.addEventListener('mouseup', function (e) { if (!drag) return; var r = wrap.getBoundingClientRect(); up(e.clientX - r.left, e.clientY - r.top); });
    wrap.addEventListener('touchstart', function (e) { var r = wrap.getBoundingClientRect(), t = e.touches[0]; down(t.clientX - r.left, t.clientY - r.top); }, { passive: true });
    wrap.addEventListener('touchmove', function (e) { var r = wrap.getBoundingClientRect(), t = e.touches[0]; move(t.clientX - r.left, t.clientY - r.top); }, { passive: true });
    wrap.addEventListener('touchend', function (e) { var r = wrap.getBoundingClientRect(); up((drag ? drag.px : 0), (drag ? drag.py : 0)); });
    window.addEventListener('resize', function () { if ($('mapModal').classList.contains('open')) { renderBigMap(); updateMapFoot(); } });
  }
  function zoomBy(f) { view.zoom = Math.max(0.6, Math.min(7, view.zoom * f)); renderBigMap(); updateMapFoot(); }
  function handleMapClick(px, py) {
    var c = toFrac(px, py);
    var a = nearestAnchor(latAt(c.fy), lngAt(c.fx));
    // crosshair flash
    var ch = $('mapCrosshair');
    ch.style.left = px + 'px'; ch.style.top = py + 'px'; ch.style.display = 'block';
    setTimeout(function () { ch.style.display = 'none'; }, 600);
    // recenter gently on the chosen anchor and apply
    view.cx = fx(a.lng); view.cy = fy(a.lat); if (view.zoom < 2) view.zoom = 2.4;
    renderBigMap(); updateMapFoot();
    setLookingZip(a.zip, { closeModal: true });
  }

  /* ---------- Lightbox ---------- */
  var lb = { list: [], i: 0, p: null };
  function openLightbox(p) {
    lb.list = p.photos || []; lb.i = state.photoIdx[p.id] || 0; lb.p = p;
    if (!lb.list.length) return;
    showLb(); $('lightbox').classList.add('open');
  }
  function showLb() {
    $('lbImg').src = lb.list[lb.i];
    $('lbCap').textContent = lb.p.title + ' · ' + lb.p.address + ', ' + lb.p.city + ' · ' + fmtUSD(lb.p.price) +
      '  (' + (lb.i + 1) + '/' + lb.list.length + ')';
  }
  function wireLightbox() {
    $('lbClose').addEventListener('click', function () { $('lightbox').classList.remove('open'); });
    $('lbPrev').addEventListener('click', function () { lb.i = (lb.i - 1 + lb.list.length) % lb.list.length; showLb(); });
    $('lbNext').addEventListener('click', function () { lb.i = (lb.i + 1) % lb.list.length; showLb(); });
    $('lightbox').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('open'); });
    document.addEventListener('keydown', function (e) {
      if (!$('lightbox').classList.contains('open')) return;
      if (e.key === 'Escape') $('lightbox').classList.remove('open');
      if (e.key === 'ArrowLeft') $('lbPrev').click();
      if (e.key === 'ArrowRight') $('lbNext').click();
    });
  }

  /* ---------- Filter UI wiring ---------- */
  function wireFilters() {
    var drops = [['priceBtn', 'priceMenu'], ['bedsBtn', 'bedsMenu'], ['sqftBtn', 'sqftMenu'], ['typeBtn', 'typeMenu']];
    drops.forEach(function (d) {
      var btn = $(d[0]), menu = $(d[1]);
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = menu.classList.contains('open');
        closeMenus();
        if (!isOpen) { menu.classList.add('open'); keepMenuOnScreen(menu); }
      });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });
    });
    document.addEventListener('click', closeMenus);

    document.querySelectorAll('[data-apply]').forEach(function (b) {
      b.addEventListener('click', function () { readPrice(); readSqft(); readTypes(); closeMenus(); markActive(); refresh(); persistContext(); });
    });

    $('bedsSeg').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        $('bedsSeg').querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        this.classList.add('on');
        state.filters.beds = this.dataset.beds ? +this.dataset.beds : null;
        markActive(); refresh();
      });
    });
    $('bedsSeg').querySelector('button').classList.add('on');

    var t;
    $('zipInput').addEventListener('input', function () {
      clearTimeout(t); var v = this.value.trim();
      t = setTimeout(function () { setLookingZip(v); }, 450);
    });
    $('zipInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { clearTimeout(t); setLookingZip(this.value.trim()); }
    });
  }
  // Flip a dropdown that would spill off the right edge of the viewport.
  function keepMenuOnScreen(menu) {
    menu.classList.remove('flip-right');
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 12) menu.classList.add('flip-right');
  }
  function readPrice() {
    state.filters.minPrice = $('minPrice').value ? +$('minPrice').value : null;
    var max = $('maxPrice').value ? +$('maxPrice').value : null;
    if (state.app && state.app.maxQualifiedPrice) {
      var cap = Math.round(state.app.maxQualifiedPrice);
      if (!max || max > cap) { max = cap; $('maxPrice').value = cap; }
    }
    state.filters.maxPrice = max;
  }
  function readSqft() { state.filters.minSqft = $('minSqft').value ? +$('minSqft').value : null; }
  function readTypes() {
    var t = [];
    document.querySelectorAll('.ptype:checked').forEach(function (c) { t.push(c.value); });
    state.filters.types = t;
    maybeLandNote();
  }
  function markActive() {
    $('priceBtn').classList.toggle('has', !!(state.filters.minPrice || state.filters.maxPrice));
    $('bedsBtn').classList.toggle('has', !!state.filters.beds);
    $('sqftBtn').classList.toggle('has', !!state.filters.minSqft);
    $('typeBtn').classList.toggle('has', state.filters.types.length !== 4);
  }
  function closeMenus() { document.querySelectorAll('.fmenu.open').forEach(function (m) { m.classList.remove('open'); }); }

  function wireSort() {
    $('sortSeg').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        $('sortSeg').querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        this.classList.add('on');
        state.sort = this.dataset.sort; render();
      });
    });
  }

  function logout() {
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function () { window.location.href = '/'; })
      .catch(function () { window.location.href = '/'; });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
