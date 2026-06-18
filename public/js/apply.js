/* apply.js — wizard controller v2: navigation, live underwriting bar, program
   eligibility filtering, closing cost breakdown, SSN, DTI block, DPA integration,
   "My Application" drawer, address lookup, correct loan term placement. */
(function () {
  'use strict';
  var Calc = window.MortgageCalc, Tax = window.TxTax, Market = window.MarketData;

  // Steps: Start | Program | Property | Income | Debts | Rate | Review
  var STEPS = ['Start', 'Program', 'Property', 'Income', 'Debts & Assets', 'Rate', 'Review'];
  var step = 0;
  var state = {
    program: 'conventional', termYears: 30, dpa: false, dpaRatePremium: 0.625,
    debts: [], assets: [], taxRatePct: null, taxCounty: null, taxSource: null,
    selectedRate: null, appType: 'solo',
    ownRent: null,    // 'own' | 'rent' | 'other'
    isOwner: false,   // true if user currently owns a home
    usdaAreaStatus: 'unknown', // 'yes'|'no'|'unknown'
  };

  var $ = function (id) { return document.getElementById(id); };
  var num = function (v) { return parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; };
  var fmt = function (n) { return '$' + Math.round(n).toLocaleString(); };

  var isAuthed = false;     // logged-in user editing a saved application
  var editingExisting = false;

  var CONFORMING_LIMIT = 806500;
  // DTI limits by program
  var MAX_BACK_DTI = { fha: 56.9, va: 60, usda: 43, conventional: 50, conventional_fthb: 50, jumbo: 43, land: 43 };

  /* ====== SSN formatting ====== */
  function formatSSN(val) {
    var digits = val.replace(/\D/g, '').slice(0, 9);
    if (digits.length <= 3) return digits;
    if (digits.length <= 5) return digits.slice(0, 3) + '-' + digits.slice(3);
    return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
  }
  function wireSSN(inputId, toggleId) {
    var inp = $(inputId), tog = $(toggleId);
    if (!inp) return;
    inp.addEventListener('input', function () {
      var pos = inp.selectionStart;
      inp.value = formatSSN(inp.value);
      try { inp.setSelectionRange(pos, pos); } catch(e) {}
    });
    if (tog) tog.addEventListener('click', function () {
      inp.type = inp.type === 'password' ? 'text' : 'password';
      tog.textContent = inp.type === 'password' ? '👁' : '🙈';
    });
  }

  /* ====== Stepper ====== */
  function renderStepper() {
    var el = $('stepper'); el.innerHTML = '';
    STEPS.forEach(function (name, i) {
      var chip = document.createElement('div');
      chip.className = 'step-chip' + (i === step ? ' active' : '') + (i < step ? ' done' : '');
      chip.innerHTML = '<span class="num">' + (i < step ? '✓' : (i + 1)) + '</span>' + name +
        (i < STEPS.length - 1 ? '<span class="arrow">›</span>' : '');
      el.appendChild(chip);
    });
  }
  function showStep(n) {
    step = Math.max(0, Math.min(STEPS.length - 1, n));
    document.querySelectorAll('.panel').forEach(function (p) {
      p.classList.toggle('show', +p.dataset.step === step);
    });
    renderStepper();
    if (step === 5) buildRateGrid();
    if (step === 6) buildReview();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    updateDrawer();
  }

  /* ====== Program eligibility filtering ====== */
  function getEligiblePrograms() {
    var eligible = {};
    var loanAmt = loanAmount();
    var isJumbo = loanAmt > CONFORMING_LIMIT && loanAmt > 0;
    var isOwner = state.isOwner; // currently owns a home

    // conventional always ok
    eligible.conventional = { ok: true };
    // FTHB: only if NOT currently owning
    eligible.conventional_fthb = {
      ok: !isOwner,
      reason: isOwner ? 'Not available: you currently own a home.' : null
    };
    eligible.fha = { ok: true };
    eligible.va = { ok: true };
    // USDA: not ok if user explicitly said area is NOT eligible
    eligible.usda = {
      ok: state.usdaAreaStatus !== 'no' && !isOwner,
      reason: state.usdaAreaStatus === 'no' ? 'Property is not in a USDA-eligible rural area.' :
              isOwner ? 'USDA requires you not to own another adequate home.' : null
    };
    // Jumbo: only ok if loan IS jumbo
    eligible.jumbo = {
      ok: isJumbo || loanAmt === 0,
      reason: (!isJumbo && loanAmt > 0) ? 'Your loan is below the $' + CONFORMING_LIMIT.toLocaleString() + ' conforming limit — Jumbo not needed.' : null
    };
    eligible.land = { ok: true };
    return eligible;
  }

  function updateProgGrid() {
    var eligible = getEligiblePrograms();
    document.querySelectorAll('#progGrid .prog').forEach(function (el) {
      var prog = el.dataset.prog;
      var e = eligible[prog] || { ok: true };
      el.classList.toggle('disabled', !e.ok);
      // remove old tag
      var old = el.querySelector('.ineligible-tag');
      if (old) old.remove();
      if (!e.ok && e.reason) {
        var tag = document.createElement('div');
        tag.className = 'ineligible-tag';
        tag.textContent = '✕ ' + e.reason;
        el.appendChild(tag);
      }
    });
    // If currently selected program became ineligible, auto-switch to conventional
    var elig = eligible[state.program];
    if (elig && !elig.ok) {
      selectProgram('conventional');
    }
    // Show/hide FTHB on income step
    var fthbWrap = $('firstTimeBuyerWrap');
    if (fthbWrap) fthbWrap.style.display = state.isOwner ? 'none' : 'inline-flex';
  }

  /* ====== Down payment hint from program ====== */
  function updateDownPayHint() {
    var note = $('progDownPayNote');
    var hint = $('downPayHint');
    if (!note) return;
    var minDownMap = { conventional: 5, conventional_fthb: 3, fha: 3.5, va: 0, usda: 0, jumbo: 10, land: 20 };
    var progLabels = { conventional: 'Conventional', conventional_fthb: 'First-Time Buyer (Conv. 97)', fha: 'FHA', va: 'VA', usda: 'USDA', jumbo: 'Jumbo', land: 'Land / Lot' };
    var min = minDownMap[state.program];
    var label = progLabels[state.program];
    if (min === 0) {
      note.innerHTML = '✓ <b>' + label + '</b> allows <b>0% down</b>. You may still choose to put money down to lower your payment or rate.';
      note.style.display = 'flex';
    } else if (min === 3 || min === 3.5) {
      note.innerHTML = '✓ <b>' + label + '</b> requires as little as <b>' + min + '% down</b>. You can always put more down.';
      note.style.display = 'flex';
    } else {
      note.innerHTML = '✓ <b>' + label + '</b> requires a minimum of <b>' + min + '% down</b>.';
      note.style.display = 'flex';
    }
    if (hint) hint.textContent = 'Minimum for ' + label + ': ' + min + '%. Enter a percentage — we\'ll compute the dollar amount and LTV.';
  }

  /* ====== Jumbo validation on property step ====== */
  function updateJumboWarning() {
    var loanAmt = loanAmount();
    var jWarn = $('jumboWarning');
    var njWarn = $('nonJumboWarning');
    if (!jWarn) return;
    var isJumbo = loanAmt > CONFORMING_LIMIT;
    var progIsJumbo = state.program === 'jumbo';
    jWarn.style.display = (!progIsJumbo && isJumbo && loanAmt > 0) ? 'flex' : 'none';
    njWarn.style.display = (progIsJumbo && !isJumbo && loanAmt > 0) ? 'flex' : 'none';
    // Also validate down payment
    validateDownPayment();
  }

  function validateDownPayment() {
    var el = $('downPayValidation');
    if (!el) return;
    var pct = num($('downPct') ? $('downPct').value : 0);
    var rule = Calc.programRules(state.program, { firstTimeBuyer: $('firstTimeBuyer') && $('firstTimeBuyer').checked });
    var minPct = rule.minDown * 100;
    if (pct > 0 && pct < minPct) {
      el.innerHTML = '⚠️ <b>' + rule.label + '</b> requires a minimum of <b>' + minPct + '% down</b>. Please increase your down payment.';
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  }

  /* ====== Income / DTI helpers ====== */
  function income() {
    var i = num($('income') ? $('income').value : 0);
    if (state.appType === 'joint') i += num($('coIncome') ? $('coIncome').value : 0);
    return i;
  }
  function loanAmount() {
    var price = num($('purchasePrice') ? $('purchasePrice').value : 0);
    var downPct = num($('downPct') ? $('downPct').value : 0) / 100;
    return Math.max(0, price - price * downPct);
  }
  function gatherDebts() {
    var total = 0;
    state.debts.forEach(function (d) {
      d.excluded = d.few || d.medical;
      if (!d.excluded) total += num(d.payment);
    });
    return total;
  }
  function gatherAssets() {
    return state.assets.reduce(function (s, a) { return s + num(a.value); }, 0);
  }

  /* ====== DTI block checking ====== */
  function isDTIBlocked(backDTI) {
    var maxBack = MAX_BACK_DTI[state.program] || 50;
    return backDTI > maxBack && backDTI > 0;
  }
  function updateDTIBanners(r) {
    ['dtiBlockBanner', 'dtiBlockBanner2'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.classList.toggle('show', isDTIBlocked(r.backDTI));
    });
    // Disable next button on income step if DTI too high and income is entered
    var incBtn = $('incomeNextBtn');
    if (incBtn) incBtn.disabled = isDTIBlocked(r.backDTI) && income() > 0;
    var debBtn = $('debtsNextBtn');
    if (debBtn) debBtn.disabled = isDTIBlocked(r.backDTI) && income() > 0;
  }

  /* ====== Closing cost breakdown ====== */
  function buildClosingCostBreakdown(r, p) {
    var el = $('closingCostBreakdown');
    if (!el) return;
    // Lender fees
    var origFee = Math.round(r.baseLoan * 0.01);          // ~1% origination
    var appraisal = 550;
    var creditReport = 65;
    var floodCert = 25;
    var titleSearch = 350;
    var titleInsuranceLender = Math.round(r.baseLoan * 0.004);
    var titleInsuranceOwner = Math.round(r.price * 0.006);
    var escrowFee = 450;
    var recording = 125;
    var survey = 500;
    var dpaFee = (state.dpa ? Math.round(r.baseLoan * 0.015) : 0); // DPA admin fee ~1.5%
    // Prepaids
    var prepaidInterest = Math.round((r.pi / 30) * 15);   // ~15 days
    var prepaidIns = Math.round(r.monthlyInsurance * 3);
    var prepaidTax = Math.round(r.monthlyTax * 3);
    var lenderFees = origFee + appraisal + creditReport + floodCert;
    var titleFees = titleSearch + titleInsuranceLender + titleInsuranceOwner + escrowFee;
    var govFees = recording;
    var otherFees = survey + (state.dpa ? dpaFee : 0);
    var prepaids = prepaidInterest + prepaidIns + prepaidTax;
    var totalClosing = lenderFees + titleFees + govFees + otherFees + prepaids;
    function row(label, amount, isSub) {
      return '<tr>' + (isSub ? '<td style="padding-left:16px;color:var(--slate)">' + label + '</td>' : '<td>' + label + '</td>') +
        '<td>' + (amount >= 0 ? fmt(amount) : '<span style="color:var(--slate-light)">Varies</span>') + '</td></tr>';
    }
    el.innerHTML =
      '<table class="cc-table">' +
        '<tr><td colspan="2" class="cc-section-head">Lender Fees</td></tr>' +
        row('Origination fee (~1% of loan)', origFee, true) +
        row('Appraisal', appraisal, true) +
        row('Credit report', creditReport, true) +
        row('Flood certification', floodCert, true) +
        '<tr><td colspan="2" class="cc-section-head">Title & Settlement</td></tr>' +
        row('Title search', titleSearch, true) +
        row('Lender\'s title insurance', titleInsuranceLender, true) +
        row('Owner\'s title insurance', titleInsuranceOwner, true) +
        row('Escrow / closing fee', escrowFee, true) +
        '<tr><td colspan="2" class="cc-section-head">Government / Recording</td></tr>' +
        row('Recording fees', recording, true) +
        '<tr><td colspan="2" class="cc-section-head">Other</td></tr>' +
        row('Survey', survey, true) +
        (state.dpa ? row('DPA program admin fee (~1.5%)', dpaFee, true) : '') +
        '<tr><td colspan="2" class="cc-section-head">Prepaids & Escrow Setup</td></tr>' +
        row('Prepaid interest (~15 days)', prepaidInterest, true) +
        row('Homeowners insurance (3 mo)', prepaidIns, true) +
        row('Property tax escrow (3 mo)', prepaidTax, true) +
        '<tr style="font-weight:700;border-top:2px solid var(--ink)"><td style="padding-top:10px">Total Estimated Closing Costs</td><td style="padding-top:10px">' + fmt(totalClosing) + '</td></tr>' +
      '</table>' +
      '<p style="font-size:12px;color:var(--slate-light);margin-top:12px">These are itemized estimates. Your Loan Estimate (issued within 3 business days of application) will show exact lender fees. Title and third-party fees vary by provider.</p>';
  }

  /* ====== DPA rate premium ====== */
  function dpaRatePremium() {
    return state.dpa ? 0.625 : 0; // ~0.625% rate increase for DPA programs
  }

  /* ====== Calc payload ====== */
  function calcPayload() {
    var price = num($('purchasePrice') ? $('purchasePrice').value : 0);
    var downPct = num($('downPct') ? $('downPct').value : 0);
    var term = state.termYears;
    var baseRate = state.selectedRate ? state.selectedRate.rate : defaultRate();
    var effectiveRate = baseRate + dpaRatePremium();
    return {
      program: state.program,
      purchasePrice: price,
      downPaymentPct: downPct,
      interestRate: effectiveRate,
      termYears: term,
      creditScore: num($('creditScore') ? $('creditScore').value : 0),
      grossMonthlyIncome: income(),
      monthlyDebts: gatherDebts(),
      hoaMonthly: num($('hoaMonthly') ? $('hoaMonthly').value : 0),
      taxRatePct: state.taxRatePct || Tax.STATEWIDE_DEFAULT,
      vaUse: $('vaUse') ? $('vaUse').value : 'first',
      vaFundingFeeExempt: $('vaExempt') ? $('vaExempt').checked : false,
      dpaAmount: state.dpa ? num($('dpaAmount') ? $('dpaAmount').value : 0) : 0,
      firstTimeBuyer: $('firstTimeBuyer') ? $('firstTimeBuyer').checked : false,
    };
  }
  function defaultRate() {
    var grid = Market.rateGrid(state.program, state.termYears, num($('creditScore') ? $('creditScore').value : 0));
    return grid.rows[2].rate;
  }

  /* ====== Live underwriting bar ====== */
  function setMetric(id, text, status) {
    var e = $(id); if (!e) return;
    e.innerHTML = text;
    e.classList.remove('good', 'warn', 'bad');
    if (status) e.classList.add(status);
  }
  function recompute() {
    var p = calcPayload();
    var r = Calc.calculate(p);
    // derived display fields
    if ($('downAmt')) $('downAmt').value = r.price ? fmt(r.downPayment) : '';
    if ($('loanReadout')) $('loanReadout').value = r.price ? fmt(r.baseLoan) : '';
    if ($('debtTotal')) $('debtTotal').textContent = fmt(gatherDebts());
    if ($('assetTotal')) $('assetTotal').textContent = fmt(gatherAssets());
    setMetric('m-pay', r.totalMonthly ? fmt(r.totalMonthly) + '<small>/mo</small>' : '$0<small>/mo</small>');
    var maxBack = MAX_BACK_DTI[p.program] || 50;
    if (p.grossMonthlyIncome > 0 && r.price > 0) {
      setMetric('m-front', r.frontDTI + '%', r.frontDTI <= 28 ? 'good' : r.frontDTI <= 36 ? 'warn' : 'bad');
      setMetric('m-back', r.backDTI + '%', r.backDTI <= maxBack * 0.75 ? 'good' : r.backDTI <= maxBack ? 'warn' : 'bad');
    } else { setMetric('m-front', '—'); setMetric('m-back', '—'); }
    if (r.price > 0) {
      setMetric('m-ltv', r.ltv + '%', r.ltv <= 80 ? 'good' : r.ltv <= 95 ? 'warn' : 'bad');
    } else setMetric('m-ltv', '—');
    setMetric('m-ctc', r.price ? fmt(r.cashToClose) : '$0');
    updateJumboWarning();
    updateDTIBanners(r);
    updateDrawer();
    return r;
  }

  /* ====== TX tax auto-fill ====== */
  function updateTax() {
    var zip = ($('propZip') ? $('propZip').value : '').trim();
    var price = num($('purchasePrice') ? $('purchasePrice').value : 0);
    var ro = $('taxReadout');
    if (zip.length === 5) {
      var t = Tax.annualTax(zip, price);
      state.taxRatePct = t.ratePct; state.taxCounty = t.county; state.taxSource = t.source;
      var label = t.source === 'county' ? (t.county + ' County estimate')
        : t.source === 'prefix' ? ('approx. ' + t.county + ' County — verify')
          : 'statewide default — please verify your county';
      ro.style.display = 'flex';
      ro.innerHTML = '🏷️ &nbsp;<span>Property tax: <b>' + t.ratePct + '%</b> effective (' + label + ') ≈ <b>' +
        fmt(t.monthly) + '/mo</b>. <a href="#" id="taxOverride" style="color:var(--green-700)">Override rate</a></span>';
      var ov = $('taxOverride');
      ov && ov.addEventListener('click', function (e) {
        e.preventDefault();
        var v = prompt('Enter the effective property-tax rate for this property (%):', t.ratePct);
        if (v != null && !isNaN(parseFloat(v))) { state.taxRatePct = parseFloat(v); state.taxSource = 'manual'; updateTax(); }
      });
    } else { if (ro) ro.style.display = 'none'; state.taxRatePct = null; }
    recompute();
  }

  /* ====== Address auto-fill for desired address (Step 1) ====== */
  function tryAddressLookup() {
    var addr = $('desiredAddress') ? $('desiredAddress').value.trim() : '';
    var status = $('addressLookupStatus');
    if (!status) return;
    // Extract ZIP from address string
    var zipMatch = addr.match(/\b(7\d{4}|885\d{2})\b/);
    if (zipMatch) {
      var zip = zipMatch[1];
      var t = Tax.estimate(zip);
      if (t.county) {
        status.textContent = '📍 Detected: ' + t.county + ' County, TX (tax ~' + t.ratePct + '%)';
        status.style.color = 'var(--green-700)';
        // Pre-fill propZip if empty
        if ($('propZip') && !$('propZip').value) $('propZip').value = zip;
        // Pre-fill desiredLocation (legacy) if it exists
      } else {
        status.textContent = 'ZIP detected but county not found — enter the property ZIP on the next step.';
        status.style.color = 'var(--slate-light)';
      }
    } else if (addr.length > 5) {
      status.textContent = 'Enter the ZIP in the property step to auto-fill taxes.';
      status.style.color = 'var(--slate-light)';
    } else {
      status.textContent = '';
    }
  }

  /* ====== Program selection ====== */
  function selectProgram(prog) {
    state.program = prog;
    document.querySelectorAll('#progGrid .prog').forEach(function (el) {
      el.classList.toggle('sel', el.dataset.prog === prog);
    });
    ['va', 'usda', 'jumbo', 'land'].forEach(function (k) {
      var c = $('cond-' + k);
      if (c) c.classList.toggle('show', prog === k);
    });
    // Update DPA note
    var dpaNote = $('dpaFeeNote');
    if (dpaNote && state.dpa) {
      dpaNote.innerHTML = '💡 DPA adds an estimated admin fee (~1.5% of loan) to your closing costs and raises your rate by ~0.625%. This is reflected in all estimates.';
    }
    // Reset selected rate when program changes
    state.selectedRate = null;
    recompute();
    updateDownPayHint();
  }

  /* ====== DPA toggle ====== */
  function updateDPA() {
    state.dpa = $('dpaToggle').checked;
    $('cond-dpa').classList.toggle('show', state.dpa);
    $('dpaToggleWrap').classList.toggle('sel', state.dpa);
    var dpaNote = $('dpaFeeNote');
    if (dpaNote) dpaNote.innerHTML = state.dpa ?
      '💡 DPA adds an estimated admin fee (~1.5% of loan) to your closing costs and raises your rate by ~0.625%. All estimates include this adjustment.' : '';
    var dpaRateNote = $('dpaRateNote');
    if (dpaRateNote) dpaRateNote.style.display = state.dpa ? 'flex' : 'none';
    state.selectedRate = null;
    recompute();
  }

  /* ====== Debt & asset rows ====== */
  function debtRow(d) {
    var wrap = document.createElement('div'); wrap.className = 'lr';
    wrap.innerHTML =
      '<label class="field" style="margin:0"><span>Type</span><select class="d-type">' +
        '<option value="auto">Auto loan</option><option value="student">Student loan</option>' +
        '<option value="card">Credit card (min)</option><option value="personal">Personal loan</option>' +
        '<option value="mortgage">Other mortgage</option><option value="support">Child/spousal support</option>' +
        '<option value="other">Other</option></select></label>' +
      '<label class="field inline-prefix" style="margin:0"><span>Monthly payment</span><span class="adorn">$</span><input class="d-pay" inputmode="numeric"></label>' +
      '<div class="field" style="margin:0"><span>Flags</span>' +
        '<label style="font-size:12px;display:flex;gap:5px;align-items:center"><input type="checkbox" class="d-few" style="width:auto"> ≤10 pmts</label>' +
        '<label style="font-size:12px;display:flex;gap:5px;align-items:center"><input type="checkbox" class="d-med" style="width:auto"> medical</label>' +
      '</div>' +
      '<button class="x" title="Remove">✕</button>';
    wrap.querySelector('.d-type').value = d.type || 'auto';
    wrap.querySelector('.d-pay').value = d.payment || '';
    wrap.querySelector('.d-few').checked = !!d.few;
    wrap.querySelector('.d-med').checked = !!d.medical;
    function sync() {
      d.type = wrap.querySelector('.d-type').value;
      d.payment = wrap.querySelector('.d-pay').value;
      d.few = wrap.querySelector('.d-few').checked;
      d.medical = wrap.querySelector('.d-med').checked;
      wrap.style.opacity = (d.few || d.medical) ? '.5' : '1';
      recompute();
    }
    wrap.querySelectorAll('input,select').forEach(function (el) { el.addEventListener('input', sync); el.addEventListener('change', sync); });
    wrap.querySelector('.x').addEventListener('click', function () {
      state.debts = state.debts.filter(function (x) { return x !== d; }); wrap.remove(); recompute();
    });
    sync();
    return wrap;
  }
  function assetRow(a) {
    var wrap = document.createElement('div'); wrap.className = 'lr'; wrap.style.gridTemplateColumns = '1.4fr 1fr auto';
    wrap.innerHTML =
      '<label class="field" style="margin:0"><span>Account type</span><select class="a-type">' +
        '<option value="checking">Checking</option><option value="savings">Savings</option>' +
        '<option value="retirement">Retirement (401k/IRA)</option><option value="gift">Gift funds</option>' +
        '<option value="other">Other</option></select></label>' +
      '<label class="field inline-prefix" style="margin:0"><span>Value</span><span class="adorn">$</span><input class="a-val" inputmode="numeric"></label>' +
      '<button class="x" title="Remove">✕</button>';
    wrap.querySelector('.a-type').value = a.type || 'checking';
    wrap.querySelector('.a-val').value = a.value || '';
    function sync() { a.type = wrap.querySelector('.a-type').value; a.value = wrap.querySelector('.a-val').value; recompute(); }
    wrap.querySelectorAll('input,select').forEach(function (el) { el.addEventListener('input', sync); });
    wrap.querySelector('.x').addEventListener('click', function () {
      state.assets = state.assets.filter(function (x) { return x !== a; }); wrap.remove(); recompute();
    });
    sync();
    return wrap;
  }

  /* ====== Rate grid ====== */
  function buildRateGrid() {
    var term = state.termYears;
    var credit = num($('creditScore') ? $('creditScore').value : 0);
    var rule = Calc.programRules(state.program, {});
    if ($('rateProgLabel')) $('rateProgLabel').value = rule.label + (state.dpa ? ' + DPA' : '');
    if ($('rateTermLabel')) $('rateTermLabel').value = term + '-year fixed';
    var grid = Market.rateGrid(state.program, term, credit);
    if ($('rateAsOf')) $('rateAsOf').textContent = 'Seed pricing as of ' + grid.asOf + '. ' + grid.disclaimer + ' Your locked rate comes from our rate desk.';
    var el = $('rateGrid'); if (!el) return;
    el.innerHTML = '';
    grid.rows.forEach(function (row) {
      var effectiveRate = row.rate + dpaRatePremium();
      var p = calcPayload(); p.interestRate = effectiveRate;
      var r = Calc.calculate(p);
      var opt = document.createElement('div'); opt.className = 'rate-opt';
      if (state.selectedRate && state.selectedRate.rate === row.rate) opt.classList.add('sel');
      var ptsLabel = row.points === 0 ? 'par (0 pts)' : row.points < 0 ? (Math.abs(row.points) + ' pt credit') : (row.points + ' pts to buy down');
      var displayRate = effectiveRate.toFixed(3);
      var displayAPR = (effectiveRate + 0.12).toFixed(2);
      opt.innerHTML = '<div class="r">' + displayRate + '%</div>' +
        '<div class="p">' + ptsLabel + ' · APR ' + displayAPR + '%</div>' +
        '<div class="pay">' + fmt(r.totalMonthly) + '/mo</div>';
      opt.addEventListener('click', function () {
        state.selectedRate = row;
        document.querySelectorAll('.rate-opt').forEach(function (o) { o.classList.remove('sel'); });
        opt.classList.add('sel'); recompute();
      });
      el.appendChild(opt);
    });
    if (!state.selectedRate) { state.selectedRate = grid.rows[2]; buildRateGrid(); }
  }

  /* ====== Review + verdict ====== */
  function buildReview() {
    var p = calcPayload(); var r = Calc.calculate(p);
    var q = Calc.qualify(r, {
      program: state.program, creditScore: p.creditScore, firstTimeBuyer: p.firstTimeBuyer,
      maxBackDTI: MAX_BACK_DTI[state.program] || 50,
    });
    var v = $('verdict');
    if (q.eligible) {
      v.className = 'verdict ok';
      v.innerHTML = '<b>Looks good.</b> Based on what you entered, this scenario fits typical ' +
        Calc.programRules(state.program, {}).label + ' guidelines. Final approval depends on full documentation and a credit pull.';
    } else {
      v.className = 'verdict no';
      v.innerHTML = '<b>A few things to review.</b><ul>' + q.reasons.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
    }
    var dpaLabel = state.dpa ? ' + DPA (' + ($('dpaProgram') ? $('dpaProgram').options[$('dpaProgram').selectedIndex].text.split('—')[0].trim() : 'DPA') + ')' : '';
    var selectedRateVal = state.selectedRate ? (state.selectedRate.rate + dpaRatePremium()).toFixed(3) : defaultRate().toFixed(3);
    var rows = [
      ['Program', Calc.programRules(state.program, {}).label + dpaLabel],
      ['Loan term', state.termYears + '-year fixed'],
      ['Purchase price', fmt(r.price)],
      ['Down payment', fmt(r.downPayment) + ' (' + r.downPct + '%)'],
      ['Base loan amount', fmt(r.baseLoan)],
      ['Financed fee (UFMIP/VA/USDA)', r.financedFee ? fmt(r.financedFee) : '—'],
      ['Rate / APR', selectedRateVal + '% / ' + (parseFloat(selectedRateVal) + 0.12).toFixed(2) + '%'],
      ['Principal & interest', fmt(r.pi) + '/mo'],
      ['Property tax', fmt(r.monthlyTax) + '/mo (' + (state.taxCounty || 'TX') + ')'],
      ['Homeowners insurance', fmt(r.monthlyInsurance) + '/mo'],
      ['Mortgage insurance / MI', r.monthlyMI ? fmt(r.monthlyMI) + '/mo' : 'none'],
      ['HOA', r.hoaMonthly ? fmt(r.hoaMonthly) + '/mo' : '—'],
      ['DPA assistance applied', state.dpa && r.dpaAmount ? fmt(r.dpaAmount) : '—'],
      ['Total monthly payment', fmt(r.totalMonthly) + '/mo'],
      ['Front / back DTI', r.frontDTI + '% / ' + r.backDTI + '%'],
      ['LTV', r.ltv + '%'],
      ['Estimated cash to close (incl. closing costs)', fmt(r.cashToClose)],
    ];
    $('reviewLines').innerHTML = rows.map(function (x) {
      return '<div class="summary-line"><span>' + x[0] + '</span><b>' + x[1] + '</b></div>';
    }).join('');
    buildClosingCostBreakdown(r, p);
    if ($('acctEmail') && !$('acctEmail').value) $('acctEmail').value = $('email') ? $('email').value : '';
  }

  /* ====== "My Application" drawer ====== */
  function updateDrawer() {
    var el = $('drawerContent'); if (!el) return;
    var firstName = $('firstName') ? $('firstName').value : '';
    if (!firstName && step === 0) {
      el.innerHTML = '<p style="color:var(--slate-light);font-size:14px">Complete Step 1 to start your application.</p>';
      return;
    }
    var p = calcPayload();
    var r = Calc.calculate(p);
    var progLabel = Calc.programRules(state.program, {}).label;
    var html = '';
    if (firstName) {
      html += '<div class="dsec">Applicant</div>';
      html += dkv('Name', (firstName + ' ' + ($('lastName') ? $('lastName').value : '')).trim() || '—', true);
      html += dkv('Email', $('email') ? $('email').value || '—' : '—', true);
      html += dkv('Phone', $('phone') ? $('phone').value || '—' : '—', true);
      html += dkv('Housing', state.ownRent || '—', true);
    }
    if (step >= 2) {
      html += '<div class="dsec">Program</div>';
      html += dkv('Program', progLabel + (state.dpa ? ' + DPA' : ''), true);
      html += dkv('Loan term', state.termYears + '-year fixed', true);
    }
    if (r.price > 0) {
      html += '<div class="dsec">Property</div>';
      html += dkv('Purchase price', fmt(r.price));
      html += dkv('Down payment', fmt(r.downPayment) + ' (' + r.downPct + '%)');
      html += dkv('Loan amount', fmt(r.baseLoan));
      html += dkv('LTV', r.ltv + '%');
      if (state.taxCounty) html += dkv('County', state.taxCounty + ' County');
    }
    if (r.totalMonthly > 0) {
      html += '<div class="dsec">Estimates</div>';
      html += dkv('Est. monthly payment', fmt(r.totalMonthly) + '/mo');
      html += dkv('Principal & interest', fmt(r.pi) + '/mo');
      html += dkv('Tax + insurance + MI', fmt(r.monthlyTax + r.monthlyInsurance + r.monthlyMI) + '/mo');
      if (r.frontDTI > 0) html += dkv('Front / back DTI', r.frontDTI + '% / ' + r.backDTI + '%');
      html += dkv('Cash to close', fmt(r.cashToClose));
    }
    el.innerHTML = html || '<p style="color:var(--slate-light);font-size:14px">Keep filling out the application to see your summary here.</p>';
  }
  function dkv(k, v, txt) {
    return '<div class="dkv"><span class="dk">' + k + '</span><span class="dv' + (txt ? ' txt' : '') + '">' + v + '</span></div>';
  }

  /* ====== Submit ====== */
  function snapshot() {
    var p = calcPayload(); var r = Calc.calculate(p);
    return {
      profile: {
        firstName: $('firstName') ? $('firstName').value : '',
        lastName: $('lastName') ? $('lastName').value : '',
        email: $('email') ? $('email').value : '',
        phone: $('phone') ? $('phone').value : '',
        dob: $('dob') ? $('dob').value : '',
        currentAddress: $('curAddress') ? $('curAddress').value : '',
        ownRent: state.ownRent,
        desiredAddress: $('desiredAddress') ? $('desiredAddress').value : '',
        lookingZip: ($('propZip') && $('propZip').value.trim()) || '',
      },
      loan: p, result: r,
      program: state.program, termYears: state.termYears, dpa: state.dpa,
      debts: state.debts, assets: state.assets,
      selectedRate: state.selectedRate, taxCounty: state.taxCounty,
      maxQualifiedPrice: Calc.maxAffordablePrice(Object.assign({}, p, { maxBackDTI: 45 })),
    };
  }
  function submit() {
    var msg = $('submitMsg');

    // Logged-in user editing their saved application — no new account needed.
    if (isAuthed) {
      if (!$('consent').checked) { msg.style.color = 'var(--red)'; msg.textContent = 'Please acknowledge the estimate disclaimer to continue.'; return; }
      msg.style.color = 'var(--slate)'; msg.textContent = 'Saving your changes…';
      fetch('/api/application', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ application: snapshot() })
      }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
        .then(function (o) {
          if (!o.ok) { msg.style.color = 'var(--red)'; msg.textContent = o.j.error || 'Could not save.'; return; }
          msg.style.color = 'var(--green-700)'; msg.textContent = 'Saved ✓';
          try { sessionStorage.setItem('ks_app_preview', JSON.stringify(snapshot())); } catch (e) {}
          window.location.href = '/dashboard.html';
        }).catch(function () {
          msg.style.color = 'var(--amber)'; msg.textContent = 'Could not reach the server — opening your dashboard.';
          try { sessionStorage.setItem('ks_app_preview', JSON.stringify(snapshot())); } catch (e) {}
          setTimeout(function () { window.location.href = '/dashboard.html'; }, 1200);
        });
      return;
    }

    var email = $('acctEmail').value.trim(), pw = $('acctPassword').value;
    if (!email || pw.length < 8) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter an email and a password of at least 8 characters.'; return; }
    if (!$('consent').checked) { msg.style.color = 'var(--red)'; msg.textContent = 'Please acknowledge the estimate disclaimer to continue.'; return; }
    msg.style.color = 'var(--slate)'; msg.textContent = 'Creating your account…';
    var payload = { email: email, password: pw, application: snapshot() };
    fetch('/api/register-and-submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), credentials: 'same-origin'
    }).then(function (res) { return res.json().then(function (j) { return { ok: res.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok) { msg.style.color = 'var(--red)'; msg.textContent = o.j.error || 'Something went wrong.'; return; }
        $('saveState').textContent = 'Saved ✓';
        // Save snapshot for "My Application" drawer too
        try { sessionStorage.setItem('ks_app_preview', JSON.stringify(snapshot())); } catch(e) {}
        window.location.href = '/dashboard.html';
      }).catch(function () {
        msg.style.color = 'var(--amber)';
        msg.textContent = 'Could not reach the server. Showing your dashboard preview.';
        try { sessionStorage.setItem('ks_app_preview', JSON.stringify(snapshot())); } catch(e) {}
        setTimeout(function () { window.location.href = '/dashboard.html'; }, 1200);
      });
  }

  /* ====== Load an existing application ("bring up the application I just did") ====== */
  function extractZip(s) {
    var m = String(s || '').match(/\b(7\d{4}|885\d{2})\b/);
    return m ? m[1] : '';
  }
  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  function bootExisting() {
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (me && me.user) isAuthed = true;
        return fetch('/api/application', { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : { application: null }; });
      })
      .then(function (j) {
        var app = j && j.application;
        if (!app) {
          // offline preview fallback
          try { var p = sessionStorage.getItem('ks_app_preview'); if (p) app = JSON.parse(p); } catch (e) {}
        }
        if (app && app.loan) { prefillFromApplication(app); }
      })
      .catch(function () {});
  }

  function prefillFromApplication(app) {
    editingExisting = true;
    var loan = app.loan || {}, prof = app.profile || {}, ctx = app.context || {};

    // Profile
    setVal('firstName', prof.firstName); setVal('lastName', prof.lastName);
    setVal('email', prof.email); setVal('phone', prof.phone); setVal('dob', prof.dob);
    setVal('curAddress', prof.currentAddress); setVal('desiredAddress', prof.desiredAddress);
    if (prof.ownRent) setRadio('ownRent', prof.ownRent);

    // Program + term + DPA
    state.termYears = loan.termYears || app.termYears || 30;
    setRadio('termChoice', String(state.termYears));
    if (app.program) selectProgram(app.program);
    if (app.dpa && $('dpaToggle')) { $('dpaToggle').checked = true; updateDPA(); }

    // Property + down payment
    setVal('purchasePrice', loan.purchasePrice || '');
    setVal('downPct', loan.downPaymentPct != null ? loan.downPaymentPct : '');
    setVal('hoaMonthly', loan.hoaMonthly || '');
    var zip = ctx.lookingZip || prof.lookingZip || extractZip(prof.desiredAddress);
    if (zip && $('propZip')) $('propZip').value = zip;

    // Income + credit
    setVal('income', loan.grossMonthlyIncome || '');
    setVal('creditScore', loan.creditScore || '');
    setVal('dpaAmount', loan.dpaAmount || '');

    // Debts & assets
    state.debts = []; if ($('debtList')) $('debtList').innerHTML = '';
    (app.debts || []).forEach(function (d) { var c = Object.assign({}, d); state.debts.push(c); $('debtList').appendChild(debtRow(c)); });
    state.assets = []; if ($('assetList')) $('assetList').innerHTML = '';
    (app.assets || []).forEach(function (a) { var c = Object.assign({}, a); state.assets.push(c); $('assetList').appendChild(assetRow(c)); });

    // Rate selection + tax
    if (app.selectedRate) state.selectedRate = app.selectedRate;
    if (zip) { updateTax(); }
    else if (loan.taxRatePct) { state.taxRatePct = loan.taxRatePct; state.taxCounty = app.taxCounty || null; }

    // Account area: editing, not creating
    if (isAuthed) {
      var card = $('accountCard');
      if (card) {
        card.querySelector('h3').textContent = 'Save your changes';
        card.querySelector('.sub').innerHTML = "You're signed in — updating the application on file. " +
          '<a href="/portal.html" style="color:var(--green-700)">Go to your portal</a>.';
        var grid = card.querySelector('.grid-2'); if (grid) grid.style.display = 'none';
      }
      if ($('acctEmail')) $('acctEmail').value = prof.email || '';
      var btn = $('submitApp'); if (btn) btn.textContent = 'Save changes →';
    }

    recompute();
    showStep(6); // jump straight to the review of what was submitted
  }
  function setVal(id, v) { var e = $(id); if (e && v != null && v !== '') e.value = v; }

  /* ====== Wire up ====== */
  function wireChoiceGroups() {
    document.querySelectorAll('[data-choice]').forEach(function (grp) {
      grp.addEventListener('change', function () {
        grp.querySelectorAll('.choice').forEach(function (c) {
          var inp = c.querySelector('input'); c.classList.toggle('sel', inp && inp.checked);
        });
        var name = grp.dataset.choice;
        if (name === 'ownRent') {
          var sel = document.querySelector('input[name=ownRent]:checked');
          state.ownRent = sel ? sel.value : null;
          state.isOwner = state.ownRent === 'own';
          updateProgGrid();
          // If first-time-buyer was checked and user now says they own, uncheck it
          if (state.isOwner && $('firstTimeBuyer')) $('firstTimeBuyer').checked = false;
        }
        if (name === 'appType') {
          state.appType = (document.querySelector('input[name=appType]:checked') || {}).value || 'solo';
          $('cond-co').classList.toggle('show', state.appType === 'joint');
        }
        if (name === 'usdaArea') {
          var ua = document.querySelector('input[name=usdaArea]:checked');
          state.usdaAreaStatus = ua ? ua.value : 'unknown';
          updateProgGrid();
        }
        if (name === 'termChoice') {
          var tc = document.querySelector('input[name=termChoice]:checked');
          state.termYears = tc ? parseInt(tc.value) : 30;
          state.selectedRate = null;
          recompute();
        }
        recompute();
      });
    });
  }

  function init() {
    renderStepper();
    wireChoiceGroups();
    wireSSN('ssn', 'ssnToggle');
    wireSSN('coSsn', 'coSsnToggle');

    // Navigation
    document.querySelectorAll('[data-next]').forEach(function (b) {
      b.addEventListener('click', function () {
        // On step 4 (income), check DTI before advancing
        if (step === 3) {
          var r = recompute();
          if (isDTIBlocked(r.backDTI) && income() > 0) return; // blocked
        }
        if (step === 4) {
          var r2 = recompute();
          if (isDTIBlocked(r2.backDTI) && income() > 0) return;
        }
        showStep(step + 1);
      });
    });
    document.querySelectorAll('[data-back]').forEach(function (b) { b.addEventListener('click', function () { showStep(step - 1); }); });

    // Input listeners
    ['purchasePrice', 'hoaMonthly', 'income', 'coIncome', 'creditScore', 'dpaAmount'].forEach(function (id) {
      var e = $(id); if (e) e.addEventListener('input', recompute);
    });
    var dpEl = $('downPct');
    if (dpEl) dpEl.addEventListener('input', function() { recompute(); validateDownPayment(); });
    var pzEl = $('propZip');
    if (pzEl) pzEl.addEventListener('input', updateTax);
    var ppEl = $('purchasePrice');
    if (ppEl) ppEl.addEventListener('input', updateTax);
    var daEl = $('desiredAddress');
    if (daEl) daEl.addEventListener('input', function() {
      tryAddressLookup();
    });

    // Program tiles
    document.querySelectorAll('#progGrid .prog').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.classList.contains('disabled')) return;
        selectProgram(el.dataset.prog);
      });
    });

    // DPA toggle
    var dpaToggle = $('dpaToggle');
    if (dpaToggle) dpaToggle.addEventListener('change', updateDPA);

    // VA/USDA conditionals
    if ($('vaExempt')) $('vaExempt').addEventListener('change', recompute);
    if ($('vaUse')) $('vaUse').addEventListener('change', recompute);

    // First-time buyer checkbox
    var ftbEl = $('firstTimeBuyer');
    if (ftbEl) ftbEl.addEventListener('change', function() {
      if (this.checked && state.isOwner) { this.checked = false; alert('You indicated you currently own a home, so First-Time Buyer programs are not available.'); return; }
      recompute();
    });

    // Debt/asset rows
    $('addDebt').addEventListener('click', function () { var d = {}; state.debts.push(d); $('debtList').appendChild(debtRow(d)); });
    $('addAsset').addEventListener('click', function () { var a = {}; state.assets.push(a); $('assetList').appendChild(assetRow(a)); });

    // Submit
    $('submitApp').addEventListener('click', submit);

    // "My Application" drawer
    var myAppBtn = $('myAppBtn');
    var drawer = $('appDrawer');
    var overlay = $('drawerOverlay');
    var closeBtn = $('drawerClose');
    if (myAppBtn) myAppBtn.addEventListener('click', function() {
      updateDrawer();
      drawer.classList.add('open');
      overlay.classList.add('show');
    });
    if (closeBtn) closeBtn.addEventListener('click', function() {
      drawer.classList.remove('open');
      overlay.classList.remove('show');
    });
    if (overlay) overlay.addEventListener('click', function() {
      drawer.classList.remove('open');
      overlay.classList.remove('show');
    });

    selectProgram('conventional');
    updateProgGrid();
    recompute();
    bootExisting();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
