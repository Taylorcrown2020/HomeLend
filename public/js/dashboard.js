/* dashboard.js — property search dashboard.
   Reads the borrower's submitted application from the server (login required)
   and uses the SAME underwriting engine (calc.js + tx-tax.js) the
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

  /* ---- Google Maps state ---- */
  var gmap = null, geocoder = null, gmapsReady = false, gmapsKey = null, gMarkers = {}, gInfo = null;
  function priceShort(n) {
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + Math.round(n / 1000) + 'k';
  }

  /* ---------- Boot ---------- */
  // Find-a-Home is a logged-in-only page. If there's no server session, send the
  // visitor to the portal login. Nothing on this page loads or renders until the
  // session is confirmed — so numbers never appear to a logged-out visitor.
  function boot() {
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.user) { location.replace('/portal.html'); return; }
        state.authed = true;
        if ($('whoami')) $('whoami').textContent = j.user.email;
        if ($('logoutBtn')) $('logoutBtn').style.display = '';
        initDashboard();
      })
      .catch(function () { location.replace('/portal.html'); });
  }
  function initDashboard() {
    wireFilters();
    wireSort();
    wireLightbox();
    $('logoutBtn').addEventListener('click', logout);
    $('mapExpandBtn').addEventListener('click', toggleMapExpand);
    var mc = $('mapCollapseBtn'); if (mc) mc.addEventListener('click', toggleMapExpand);
    window.addEventListener('resize', positionBar);
    loadConfigAndMaps();
    Promise.all([loadApplication(), loadSaved()]).then(function () {
      hydrateFromApp();
      applyQualifiedRange();
      refresh();
    });
  }

  function loadApplication() {
    // Server is the only source of truth — no client-side fallback.
    return fetch('/api/application', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : { application: null }; })
      .then(function (j) { if (j && j.application) state.app = j.application; })
      .catch(function () {});
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
      renderGoogleMarkers([]);
      return;
    }
    cards.innerHTML = arr.map(cardHTML).join('');
    arr.forEach(wireCard);
    renderGoogleMarkers(arr);
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
    refreshMarkerStyles();
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

    if (state.app) state.app.context = Object.assign({}, state.app.context, context);

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
    refresh();          // new houses + markers
    persistContext();   // new zip + tax rate onto the application
  }

  /* ---------- Google Maps ---------- */
  function loadConfigAndMaps() {
    fetch('/api/config', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (cfg) {
        gmapsKey = (cfg && cfg.googleMapsKey) || '';
        if (!gmapsKey) { mapFallbackNotice(); return; }
        injectMapsScript(gmapsKey);
      })
      .catch(function () { mapFallbackNotice(); });
  }
  function mapFallbackNotice() {
    var note = $('mapNote');
    if (note) note.innerHTML = 'Add a Google Maps API key to <code>.env</code> (GOOGLE_MAPS_API_KEY) to see homes on a live map. ' +
      'Your listings still appear in the list on the left.';
    var btn = $('mapExpandBtn'); if (btn) btn.style.display = 'none';
    var gm = $('gmap'); if (gm) gm.style.display = 'none';
  }
  function injectMapsScript(key) {
    if (window.google && window.google.maps) { initGoogleMap(); return; }
    window.__ksInitGoogleMaps = initGoogleMap;
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) +
      '&libraries=geocoding&callback=__ksInitGoogleMaps&loading=async';
    s.async = true; s.defer = true;
    s.onerror = function () { mapFallbackNotice(); };
    document.head.appendChild(s);
  }
  function initGoogleMap() {
    var el = $('gmap'); if (!el || !window.google) return;
    gmap = new google.maps.Map(el, {
      center: { lat: 31.2, lng: -99.0 }, zoom: 6,   // Texas
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
      clickableIcons: false,
      styles: [
        { featureType: 'poi', stylers: [{ visibility: 'off' }] },
        { featureType: 'transit', stylers: [{ visibility: 'off' }] }
      ]
    });
    geocoder = new google.maps.Geocoder();
    gInfo = new google.maps.InfoWindow();
    // Click on empty map → reverse-geocode to a ZIP → look there.
    gmap.addListener('click', function (e) {
      reverseGeocodeToZip(e.latLng);
    });
    gmapsReady = true;
    renderGoogleMarkers(sortListings(state.listings));
  }

  function pinIcon(text, selected) {
    var bg = selected ? '#137A52' : '#0E1726';
    var w = Math.max(46, 14 + text.length * 8), h = 34;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
      '<rect x="1.5" y="1.5" rx="11" ry="11" width="' + (w - 3) + '" height="21" fill="' + bg + '" stroke="#ffffff" stroke-width="2"/>' +
      '<path d="M' + (w / 2 - 6) + ' 22 L' + (w / 2) + ' 31 L' + (w / 2 + 6) + ' 22 Z" fill="' + bg + '"/>' +
      '<text x="' + (w / 2) + '" y="17" text-anchor="middle" font-family="monospace" font-size="12" font-weight="700" fill="#ffffff">' + text + '</text>' +
      '</svg>';
    return {
      url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
      scaledSize: new google.maps.Size(w, h),
      anchor: new google.maps.Point(w / 2, 31)
    };
  }
  function clearMarkers() {
    Object.keys(gMarkers).forEach(function (id) { gMarkers[id].setMap(null); });
    gMarkers = {};
  }
  // Render listings as markers at their true coordinates and frame them.
  function renderGoogleMarkers(arr) {
    if (!gmapsReady || !gmap) return;
    clearMarkers();
    var bounds = new google.maps.LatLngBounds();
    var any = false;
    (arr || []).forEach(function (p) {
      if (!isFinite(p.lat) || !isFinite(p.lng)) return;
      var pos = { lat: +p.lat, lng: +p.lng };
      var sel = String(p.id) === String(state.selectedId);
      var m = new google.maps.Marker({
        position: pos, map: gmap, icon: pinIcon(priceShort(p.price), sel),
        title: p.title + ' · ' + fmtUSD(p.price), zIndex: sel ? 999 : 1
      });
      m.addListener('click', function () {
        selectListing(p.id);
        gInfo.setContent('<div style="font-family:Inter,sans-serif;min-width:150px">' +
          '<div style="font-weight:600">' + escapeHtml(p.title) + '</div>' +
          '<div style="color:#46566A;font-size:12.5px">' + escapeHtml(p.address) + ', ' + escapeHtml(p.city) + ' ' + p.zip + '</div>' +
          '<div style="margin-top:4px;font-weight:700">' + fmtUSD(p.price) + ' · ' + (p.beds || 0) + ' bd / ' + (p.baths || 0) + ' ba</div></div>');
        gInfo.open(gmap, m);
      });
      gMarkers[String(p.id)] = m;
      bounds.extend(pos); any = true;
    });
    if (any) {
      gmap.fitBounds(bounds, 60);
      // don't over-zoom a single marker
      google.maps.event.addListenerOnce(gmap, 'idle', function () {
        if (gmap.getZoom() > 15) gmap.setZoom(15);
      });
    } else if (state.filters.zip) {
      centerOnZip(state.filters.zip);
    }
  }
  function refreshMarkerStyles() {
    Object.keys(gMarkers).forEach(function (id) {
      var p = findListing(id); if (!p) return;
      var sel = id === String(state.selectedId);
      gMarkers[id].setIcon(pinIcon(priceShort(p.price), sel));
      gMarkers[id].setZIndex(sel ? 999 : 1);
    });
  }
  function reverseGeocodeToZip(latLng) {
    if (!geocoder) return;
    geocoder.geocode({ location: latLng }, function (results, status) {
      if (status !== 'OK' || !results || !results.length) return;
      var zip = null;
      for (var i = 0; i < results.length && !zip; i++) {
        var comps = results[i].address_components || [];
        for (var j = 0; j < comps.length; j++) {
          if (comps[j].types.indexOf('postal_code') !== -1) { zip = comps[j].short_name; break; }
        }
      }
      if (zip) { gmap.panTo(latLng); setLookingZip(zip); }
    });
  }
  function centerOnZip(zip) {
    if (!geocoder) return;
    geocoder.geocode({ address: zip + ', TX, USA' }, function (results, status) {
      if (status === 'OK' && results && results[0]) {
        gmap.setCenter(results[0].geometry.location);
        gmap.setZoom(12);
      }
    });
  }
  function toggleMapExpand() {
    var col = document.querySelector('.mapcol');
    if (!col) return;
    var expanded = col.classList.toggle('expanded');
    document.body.style.overflow = expanded ? 'hidden' : '';
    // let the layout settle, then tell Google to re-measure and re-fit
    setTimeout(function () {
      if (gmap && window.google) {
        google.maps.event.trigger(gmap, 'resize');
        renderGoogleMarkers(sortListings(state.listings));
      }
    }, 60);
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
