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
    debts: [], assets: [], reos: [], taxRatePct: null, taxCounty: null, taxSource: null,
    selectedRate: null, appType: 'solo',
    ownRent: null,    // 'own' | 'rent' | 'other'
    isOwner: false,   // true if user currently owns a home
    ownedRecently: null, // owned/sold a home in last 3 yrs → not a first-time buyer
    loanPurpose: 'purchase',  // purchase | refinance | investment | second_home
    occupancy: 'primary',     // primary | second | investment
    refi: { value: 0, payoff: 0, type: 'rate_term', cashOut: 0, financeCosts: true },
    usdaAreaStatus: 'unknown', // 'yes'|'no'|'unknown'
  };

  var $ = function (id) { return document.getElementById(id); };
  var num = function (v) { return parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0; };
  var fmt = function (n) { return '$' + Math.round(n).toLocaleString(); };

  var isAuthed = false;     // logged-in user editing a saved application
  var editingExisting = false;

  var CONFORMING_LIMIT = 806500;
  // DTI limits by program
  // Back-end DTI ceilings come from the shared calc rule table (single source of
  // truth). Falls back to sane defaults if the engine isn't loaded yet.
  var MAX_BACK_DTI = (function () {
    var m = {}, programs = ['conventional', 'conventional_fthb', 'fha', 'va', 'usda', 'jumbo', 'land'];
    if (window.MortgageCalc && MortgageCalc.maxBackDTIFor) {
      programs.forEach(function (p) { m[p] = MortgageCalc.maxBackDTIFor(p); });
      return m;
    }
    return { fha: 56.9, va: 60, usda: 43, conventional: 50, conventional_fthb: 50, jumbo: 43, land: 43 };
  })();

  /* ====== SSN formatting ====== */
  function formatSSN(val) {
    var digits = val.replace(/\D/g, '').slice(0, 9);
    if (digits.length <= 3) return digits;
    if (digits.length <= 5) return digits.slice(0, 3) + '-' + digits.slice(3);
    return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
  }
  // How many digits sit to the left of the caret, so we can re-place the caret
  // AFTER the same digit once dashes are (re)inserted — typing stays in order.
  function digitsLeftOf(value, caret) {
    return value.slice(0, caret).replace(/\D/g, '').length;
  }
  function caretAfterNDigits(formatted, n) {
    if (n <= 0) return 0;
    var seen = 0;
    for (var i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) { seen++; if (seen === n) return i + 1; }
    }
    return formatted.length;
  }
  function wireSSN(inputId, toggleId) {
    var inp = $(inputId), tog = $(toggleId);
    if (!inp) return;
    inp.addEventListener('input', function () {
      var raw = inp.value;
      var caret = inp.selectionStart;                 // may be null on some password inputs
      var hasCaret = (caret !== null && caret !== undefined);
      var nLeft = hasCaret ? digitsLeftOf(raw, caret) : 0;
      var formatted = formatSSN(raw);
      if (formatted === raw && hasCaret) return;       // nothing changed → leave caret alone
      inp.value = formatted;
      if (hasCaret) {
        var pos = caretAfterNDigits(formatted, nLeft);
        try { inp.setSelectionRange(pos, pos); } catch (e) {}
      }
      // when caret is unreadable (rare), value assignment leaves it at the end,
      // which is correct for normal left-to-right typing.
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
  // Real-world occupancy rules: FHA/VA/USDA are owner-occupied (primary) only;
  // Conventional 97 / DPA require a primary residence AND a first-time buyer
  // (no ownership in the last 3 years). Second homes and investment properties
  // are Conventional/Jumbo only, with higher minimum down.
  function getEligiblePrograms() {
    var eligible = {};
    var loanAmt = loanAmount();
    var isJumbo = loanAmt > CONFORMING_LIMIT && loanAmt > 0;
    var occ = state.occupancy || 'primary';
    var primary = occ === 'primary';

    // Refinance: Conventional / FHA / VA / Jumbo only (no USDA-rural, FTHB, land).
    if (state.loanPurpose === 'refinance') {
      eligible.conventional = { ok: true };
      eligible.conventional_fthb = { ok: false, reason: 'First-time-buyer programs are for purchases.' };
      eligible.fha = { ok: true };
      eligible.va = { ok: true };
      eligible.usda = { ok: false, reason: 'Not offered for refinances here.' };
      eligible.jumbo = { ok: isJumbo || loanAmt === 0, reason: (!isJumbo && loanAmt > 0) ? 'Below the conforming limit — Jumbo not needed.' : null };
      eligible.land = { ok: false, reason: 'Not applicable to a refinance.' };
      return eligible;
    }

    var fthb = state.ownedRecently === false;
    var notPrimaryReason = occ === 'investment' ? 'Not available for investment properties.' : 'Not available for second homes.';
    eligible.conventional = { ok: true };
    eligible.conventional_fthb = {
      ok: primary && fthb,
      reason: !primary ? notPrimaryReason : (!fthb ? 'First-Time Buyer (Conv. 97) requires no home ownership in the last 3 years.' : null)
    };
    eligible.fha = { ok: primary, reason: primary ? null : notPrimaryReason + ' FHA is owner-occupied only.' };
    eligible.va  = { ok: primary, reason: primary ? null : notPrimaryReason + ' VA is owner-occupied only.' };
    eligible.usda = {
      ok: primary && state.usdaAreaStatus !== 'no',
      reason: !primary ? (notPrimaryReason + ' USDA is owner-occupied only.') :
              state.usdaAreaStatus === 'no' ? 'Property is not in a USDA-eligible rural area.' : null
    };
    eligible.jumbo = {
      ok: isJumbo || loanAmt === 0,
      reason: (!isJumbo && loanAmt > 0) ? 'Your loan is below the $' + CONFORMING_LIMIT.toLocaleString() + ' conforming limit — Jumbo not needed.' : null
    };
    eligible.land = { ok: true };
    return eligible;
  }
  // Minimum down payment (%) for program + occupancy, from the shared rule table.
  function minDownFor(program, occ) {
    occ = occ || state.occupancy || 'primary';
    var credit = num($('creditScore') ? $('creditScore').value : 0);
    if (window.MortgageCalc && MortgageCalc.minDown) return Math.round(MortgageCalc.minDown(program, occ, credit) * 1000) / 10;
    if (program === 'conventional') return occ === 'investment' ? 15 : occ === 'second' ? 10 : 5;
    var map = { conventional_fthb: 3, fha: 3.5, va: 0, usda: 0, jumbo: occ === 'primary' ? 10 : 20, land: 20 };
    return map[program] != null ? map[program] : 5;
  }
  // DPA is for primary-residence, first-time buyers only.
  function dpaAllowed() { return state.loanPurpose === 'purchase' && (state.occupancy || 'primary') === 'primary' && state.ownedRecently === false; }

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
    // FTHB is now derived from the page-1 ownership question — hide the manual box.
    var fthbWrap = $('firstTimeBuyerWrap');
    if (fthbWrap) fthbWrap.style.display = 'none';
    // DPA toggle only for primary-residence first-time buyers.
    var dpaWrap = $('dpaToggleWrap');
    if (dpaWrap) {
      var allowed = dpaAllowed();
      dpaWrap.style.display = allowed ? 'inline-flex' : 'none';
      if (!allowed && state.dpa) { state.dpa = false; if ($('dpaToggle')) $('dpaToggle').checked = false; updateDPA(); }
    }
  }

  /* ====== Down payment hint from program ====== */
  function updateDownPayHint() {
    var note = $('progDownPayNote');
    var hint = $('downPayHint');
    if (!note) return;
    var progLabels = { conventional: 'Conventional', conventional_fthb: 'First-Time Buyer (Conv. 97)', fha: 'FHA', va: 'VA', usda: 'USDA', jumbo: 'Jumbo', land: 'Land / Lot' };
    var min = minDownFor(state.program);
    var label = progLabels[state.program];
    var occNote = (state.occupancy === 'investment') ? ' (investment property)' : (state.occupancy === 'second') ? ' (second home)' : '';
    if (min === 0) {
      note.innerHTML = '✓ <b>' + label + '</b> allows <b>0% down</b>. You may still choose to put money down to lower your payment or rate.';
    } else {
      note.innerHTML = '✓ <b>' + label + '</b>' + occNote + ' requires a minimum of <b>' + min + '% down</b>.';
    }
    note.style.display = 'flex';
    if (hint) hint.textContent = 'Minimum for ' + label + occNote + ': ' + min + '%. Enter a percentage — we\'ll compute the dollar amount and LTV.';
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
    if (state.loanPurpose === 'refinance') { el.style.display = 'none'; return; } // refi validated via LTV
    var pct = num($('downPct') ? $('downPct').value : 0);
    var rule = Calc.programRules(state.program, {
      firstTimeBuyer: isFirstTimeBuyer(), occupancy: state.occupancy,
      creditScore: num($('creditScore') ? $('creditScore').value : 0)
    });
    var minPct = Math.round(rule.minDown * 1000) / 10;
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
    i += gatherREO().incomeAdd;   // + net positive rental income (75% rule)
    return i;
  }
  function loanAmount() {
    if (state.loanPurpose === 'refinance') {
      readRefiInputs();
      var co = state.refi.type === 'cash_out' ? state.refi.cashOut : 0;
      return Math.max(0, state.refi.payoff + co);
    }
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
    total += gatherREO().debtAdd;  // + retained-property PITI / negative rental
    return total;
  }
  // Real-estate-owned: per-property PITI and how each affects qualifying numbers.
  //  • Keeping (not rented): full PITI counts as a monthly liability.
  //  • Renting out: net rental = 75% of gross rent − PITI. Positive adds to
  //    income; negative adds to liabilities (Fannie Mae rental-income rule).
  //  • Selling before/at closing: excluded (proof of closing required).
  function reoPITI(p) {
    var balance = num(p.balance), rate = num(p.rate);
    var pi = (balance > 0 && rate > 0) ? Calc.principalAndInterest(balance, rate, 30) : 0;
    return pi + num(p.tax) + num(p.ins) + num(p.mi);
  }
  function gatherREO() {
    var debtAdd = 0, incomeAdd = 0, totalPITI = 0;
    (state.reos || []).forEach(function (p) {
      var piti = reoPITI(p);
      totalPITI += piti;
      if (p.disposition === 'sell') return;                 // excluded
      if (p.disposition === 'rent') {
        var net = 0.75 * num(p.rent) - piti;
        if (net >= 0) incomeAdd += net; else debtAdd += -net;
      } else {                                              // 'keep'
        debtAdd += piti;
      }
    });
    return { debtAdd: Math.round(debtAdd), incomeAdd: Math.round(incomeAdd), totalPITI: Math.round(totalPITI), count: (state.reos || []).length };
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
    var term = state.termYears;
    var baseRate = state.selectedRate ? state.selectedRate.rate : defaultRate();
    var effectiveRate = baseRate + dpaRatePremium();
    var common = {
      program: state.program,
      interestRate: effectiveRate,
      termYears: term,
      creditScore: num($('creditScore') ? $('creditScore').value : 0),
      grossMonthlyIncome: income(),
      monthlyDebts: gatherDebts(),
      taxRatePct: state.taxRatePct || Tax.STATEWIDE_DEFAULT,
      vaUse: $('vaUse') ? $('vaUse').value : 'first',
      vaFundingFeeExempt: $('vaExempt') ? $('vaExempt').checked : false,
      discountPoints: state.selectedRate ? (+state.selectedRate.points || 0) : 0,
      occupancy: state.occupancy,
      loanPurpose: state.loanPurpose,
    };
    if (state.loanPurpose === 'refinance') {
      readRefiInputs();
      return Object.assign(common, {
        mode: 'refinance',
        homeValue: state.refi.value,
        payoff: state.refi.payoff,
        refiType: state.refi.type,
        cashOut: state.refi.type === 'cash_out' ? state.refi.cashOut : 0,
        financeClosingCosts: state.refi.financeCosts,
        hoaMonthly: num($('refiHoa') ? $('refiHoa').value : 0),
        firstTimeBuyer: false,
      });
    }
    return Object.assign(common, {
      purchasePrice: num($('purchasePrice') ? $('purchasePrice').value : 0),
      downPaymentPct: num($('downPct') ? $('downPct').value : 0),
      hoaMonthly: num($('hoaMonthly') ? $('hoaMonthly').value : 0),
      dpaAmount: state.dpa ? num($('dpaAmount') ? $('dpaAmount').value : 0) : 0,
      firstTimeBuyer: isFirstTimeBuyer(),
    });
  }
  function readRefiInputs() {
    state.refi.value = num($('refiValue') ? $('refiValue').value : 0);
    state.refi.payoff = num($('refiPayoff') ? $('refiPayoff').value : 0);
    state.refi.cashOut = num($('refiCashOut') ? $('refiCashOut').value : 0);
    var rt = document.querySelector('input[name=refiType]:checked');
    state.refi.type = rt ? rt.value : 'rate_term';
    state.refi.financeCosts = $('refiFinanceCosts') ? $('refiFinanceCosts').checked : true;
  }
  // First-time buyer = no ownership in the last 3 years (the real IRS/agency test).
  function isFirstTimeBuyer() { return state.ownedRecently === false; }
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
    // For a cash-out refinance, the meaningful figure is cash TO the borrower.
    if (r.mode === 'refinance' && r.refiType === 'cash_out') {
      setMetric('m-ctc', r.price ? fmt(r.cashToBorrower) : '$0');
      var lbl = document.querySelector('[data-metric-label="ctc"]'); if (lbl) lbl.textContent = 'Cash to you';
    } else {
      setMetric('m-ctc', r.price ? fmt(r.cashToClose) : '$0');
      var lbl2 = document.querySelector('[data-metric-label="ctc"]'); if (lbl2) lbl2.textContent = 'Cash to close';
    }
    updateJumboWarning();
    updateDTIBanners(r);
    renderReoSummary();
    if (state.loanPurpose === 'refinance') updateRefi();
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

  /* ====== Real estate owned (REO) — current/other homes ====== */
  function propertyRow(p) {
    var wrap = document.createElement('div'); wrap.className = 'reo-card';
    wrap.innerHTML =
      '<div class="reo-grid">' +
        '<label class="field" style="margin:0;grid-column:1/-1"><span>Property address</span><input class="p-addr" placeholder="Street, City, State ZIP"></label>' +
        '<label class="field inline-prefix" style="margin:0"><span>Estimated value</span><span class="adorn">$</span><input class="p-val" inputmode="numeric"></label>' +
        '<label class="field inline-prefix" style="margin:0"><span>Mortgage balance</span><span class="adorn">$</span><input class="p-bal" inputmode="numeric"></label>' +
        '<label class="field inline-suffix" style="margin:0"><span>Interest rate</span><input class="p-rate" inputmode="decimal"><span class="adorn-r">%</span></label>' +
        '<label class="field inline-prefix" style="margin:0"><span>Property tax /mo</span><span class="adorn">$</span><input class="p-tax" inputmode="numeric"></label>' +
        '<label class="field inline-prefix" style="margin:0"><span>Insurance /mo</span><span class="adorn">$</span><input class="p-ins" inputmode="numeric"></label>' +
        '<label class="field inline-prefix" style="margin:0"><span>PMI/MIP /mo</span><span class="adorn">$</span><input class="p-mi" inputmode="numeric"></label>' +
        '<label class="field" style="margin:0"><span>What will you do with it?</span><select class="p-disp">' +
          '<option value="keep">Keep it (not renting)</option>' +
          '<option value="rent">Rent it out</option>' +
          '<option value="sell">Selling before closing</option></select></label>' +
        '<label class="field inline-prefix p-rentwrap" style="margin:0;display:none"><span>Expected monthly rent</span><span class="adorn">$</span><input class="p-rent" inputmode="numeric"></label>' +
      '</div>' +
      '<div class="reo-foot"><span class="reo-eff"></span><button class="x" title="Remove">✕ Remove property</button></div>';
    var q = function (s) { return wrap.querySelector(s); };
    q('.p-addr').value = p.address || ''; q('.p-val').value = p.value || ''; q('.p-bal').value = p.balance || '';
    q('.p-rate').value = p.rate || ''; q('.p-tax').value = p.tax || ''; q('.p-ins').value = p.ins || '';
    q('.p-mi').value = p.mi || ''; q('.p-disp').value = p.disposition || 'keep'; q('.p-rent').value = p.rent || '';
    function sync() {
      p.address = q('.p-addr').value; p.value = q('.p-val').value; p.balance = q('.p-bal').value;
      p.rate = q('.p-rate').value; p.tax = q('.p-tax').value; p.ins = q('.p-ins').value;
      p.mi = q('.p-mi').value; p.disposition = q('.p-disp').value; p.rent = q('.p-rent').value;
      q('.p-rentwrap').style.display = p.disposition === 'rent' ? '' : 'none';
      var piti = reoPITI(p);
      var eff = q('.reo-eff');
      if (p.disposition === 'sell') eff.innerHTML = 'Excluded from DTI (selling before closing). Est. payment ' + fmt(piti) + '/mo.';
      else if (p.disposition === 'rent') {
        var net = 0.75 * num(p.rent) - piti;
        eff.innerHTML = 'Est. payment ' + fmt(piti) + '/mo · 75% of rent ' + fmt(0.75 * num(p.rent)) + ' → ' +
          (net >= 0 ? '<b style="color:var(--green-700)">+' + fmt(net) + '/mo income</b>' : '<b style="color:var(--red)">' + fmt(net) + '/mo added to debts</b>');
      } else eff.innerHTML = 'Est. payment <b>' + fmt(piti) + '/mo</b> counts as a monthly debt (you are keeping it).';
      recompute();
    }
    wrap.querySelectorAll('input,select').forEach(function (el) { el.addEventListener('input', sync); el.addEventListener('change', sync); });
    q('.x').addEventListener('click', function () { state.reos = state.reos.filter(function (x) { return x !== p; }); wrap.remove(); renderReoSummary(); recompute(); });
    sync();
    return wrap;
  }
  function renderReoSummary() {
    var el = $('reoSummary'); if (!el) return;
    var g = gatherREO();
    if (!g.count) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    var parts = [];
    if (g.incomeAdd) parts.push('<b style="color:var(--green-700)">+' + fmt(g.incomeAdd) + '/mo</b> net rental income');
    if (g.debtAdd) parts.push('<b>' + fmt(g.debtAdd) + '/mo</b> added to monthly debts');
    el.innerHTML = g.count + ' propert' + (g.count === 1 ? 'y' : 'ies') + ': ' + (parts.join(' · ') || 'no DTI impact');
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
      program: state.program, creditScore: p.creditScore, firstTimeBuyer: p.firstTimeBuyer, occupancy: state.occupancy,
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
    var rateRow = ['Rate / APR', selectedRateVal + '% / ' + (parseFloat(selectedRateVal) + 0.12).toFixed(2) + '%'];
    var rows;
    if (r.mode === 'refinance') {
      rows = [
        ['Loan purpose', r.refiType === 'cash_out' ? 'Cash-out refinance' : 'Rate & term refinance'],
        ['Program', Calc.programRules(state.program, {}).label],
        ['Loan term', state.termYears + '-year fixed'],
        ['Estimated home value', fmt(r.homeValue)],
        ['Current payoff', fmt(r.payoff)],
        ['Equity', fmt(r.equity)],
        (r.refiType === 'cash_out' ? ['Cash out requested', fmt(r.cashOut)] : null),
        ['New loan amount', fmt(r.baseLoan)],
        rateRow,
        ['Principal & interest', fmt(r.pi) + '/mo'],
        ['Property tax', fmt(r.monthlyTax) + '/mo (' + (state.taxCounty || 'TX') + ')'],
        ['Homeowners insurance', fmt(r.monthlyInsurance) + '/mo'],
        ['Mortgage insurance / MI', r.monthlyMI ? fmt(r.monthlyMI) + '/mo' : 'none'],
        ['HOA', r.hoaMonthly ? fmt(r.hoaMonthly) + '/mo' : '—'],
        ['Total monthly payment', fmt(r.totalMonthly) + '/mo'],
        ['Front / back DTI', r.frontDTI + '% / ' + r.backDTI + '%'],
        ['LTV (max ' + r.ltvCap + '%)', r.ltv + '%' + (r.ltvOver ? ' ⚠ over limit' : '')],
        (r.refiType === 'cash_out' ? ['Estimated cash to you', fmt(r.cashToBorrower)] : ['Estimated cash to close', fmt(r.cashToClose)]),
      ].filter(Boolean);
    } else {
      rows = [
      ['Program', Calc.programRules(state.program, {}).label + dpaLabel],
      ['Loan term', state.termYears + '-year fixed'],
      ['Purchase price', fmt(r.price)],
      ['Down payment', fmt(r.downPayment) + ' (' + r.downPct + '%)'],
      ['Base loan amount', fmt(r.baseLoan)],
      ['Financed fee (UFMIP/VA/USDA)', r.financedFee ? fmt(r.financedFee) : '—'],
      rateRow,
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
    }
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
      loanPurpose: state.loanPurpose, occupancy: state.occupancy, ownedRecently: state.ownedRecently,
      refi: state.refi,
      debts: state.debts, assets: state.assets, reos: state.reos,
      reoSummary: gatherREO(),
      selectedRate: state.selectedRate, taxCounty: state.taxCounty,
      maxQualifiedPrice: Calc.maxAffordablePrice(Object.assign({}, p, { maxBackDTI: 45 })),
    };
  }
  // Robustly read a fetch response as JSON even if the server returned HTML.
  function readJson(res) {
    return res.text().then(function (t) {
      var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: 'Unexpected server response.' }; }
      return { ok: res.ok, status: res.status, j: j };
    });
  }
  function showProcessing() {
    $('decisionProcessing').style.display = '';
    $('decisionResult').style.display = 'none';
    $('decisionOverlay').classList.add('open');
  }
  function showDecision(approved, reasons) {
    $('decisionProcessing').style.display = 'none';
    $('decisionResult').style.display = '';
    if (approved) {
      $('decisionIcon').textContent = '✅';
      $('decisionTitle').textContent = 'Pre-qualification approved';
      $('decisionBody').innerHTML = 'Congratulations — based on what you entered, this scenario meets typical guidelines. ' +
        'This is an estimate, not a commitment to lend; final approval requires full documentation, a credit pull, and underwriting.';
    } else {
      $('decisionIcon').textContent = '📋';
      $('decisionTitle').textContent = 'Submitted — needs a closer look';
      $('decisionBody').innerHTML = 'Your application is saved. A loan officer will review these items with you:<br>' +
        '<span style="display:inline-block;text-align:left;margin-top:8px;font-size:13.5px">• ' +
        (reasons && reasons.length ? reasons.join('<br>• ') : 'Manual review of your scenario.') + '</span>';
    }
  }
  function closeDecisionToPortal() { window.location.href = '/portal.html'; }

  function submit() {
    var msg = $('submitMsg');
    if (!$('consent').checked) { msg.style.color = 'var(--red)'; msg.textContent = 'Please acknowledge the estimate disclaimer to continue.'; return; }

    var app = snapshot();
    // Automated decision from the same engine driving the live numbers.
    var p = calcPayload();
    var qz = Calc.qualify(Calc.calculate(p), {
      program: state.program, creditScore: p.creditScore, firstTimeBuyer: p.firstTimeBuyer, occupancy: state.occupancy,
      maxBackDTI: MAX_BACK_DTI[state.program] || 50,
    });

    var path, body;
    if (isAuthed) {
      path = '/api/application';
      body = { application: app };
    } else {
      var email = $('acctEmail').value.trim(), pw = $('acctPassword').value;
      if (!email || pw.length < 8) { msg.style.color = 'var(--red)'; msg.textContent = 'Enter an email and a password of at least 8 characters.'; return; }
      path = '/api/register-and-submit';
      body = { email: email, password: pw, application: app };
    }

    msg.textContent = '';
    showProcessing();
    var started = Date.now();
    fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin', body: JSON.stringify(body)
    }).then(readJson).then(function (o) {
      // hold the "processing" view for a beat so it reads as a real review
      var wait = Math.max(0, 1600 - (Date.now() - started));
      setTimeout(function () {
        if (!o.ok) {
          $('decisionOverlay').classList.remove('open');
          msg.style.color = 'var(--red)';
          msg.textContent = (o.j && o.j.error) || ('Could not submit (error ' + o.status + '). Please try again.');
          return;
        }
        showDecision(qz.eligible, qz.reasons);
      }, wait);
    }).catch(function () {
      var wait = Math.max(0, 1200 - (Date.now() - started));
      setTimeout(function () {
        $('decisionOverlay').classList.remove('open');
        msg.style.color = 'var(--red)';
        msg.textContent = 'Could not reach the server — please make sure it is running and try again.';
      }, wait);
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
    var params = (function () { try { return new URLSearchParams(location.search); } catch (e) { return { get: function () { return null; } }; } })();
    var editPurpose = params.get('purpose');
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (me) {
        if (!(me && me.user)) return null;       // not logged in → normal new-account flow
        isAuthed = true;
        applyAuthedUI();
        return fetch('/api/applications', { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : { applications: [] }; })
          .then(function (list) {
            var apps = (list && list.applications) || [];
            disableUsedPurposes(apps, editPurpose);
            if (editPurpose) {
              // Editing a specific product → load it fully.
              return fetch('/api/application?purpose=' + encodeURIComponent(editPurpose), { credentials: 'same-origin' })
                .then(function (r) { return r.ok ? r.json() : { application: null }; })
                .then(function (j) {
                  if (j && j.application && j.application.loan) prefillFromApplication(j.application);
                  else if (apps.length) offerAutofill();
                });
            }
            // New application → offer to reuse personal info from a prior one.
            if (apps.length) offerAutofill();
          });
      })
      .catch(function () {});
  }
  // Logged-in users never see the "create an account" card again.
  function applyAuthedUI() {
    var card = $('accountCard');
    if (card) {
      var h = card.querySelector('h3'); if (h) h.textContent = "You're signed in";
      var sub = card.querySelector('.sub'); if (sub) sub.innerHTML = 'This application will be saved to your account. <a href="/portal.html" style="color:var(--green-700)">Go to your portal</a>.';
      var grid = card.querySelector('.grid-2'); if (grid) grid.style.display = 'none';
    }
    var btn = $('submitApp'); if (btn) btn.textContent = 'Submit application →';
  }
  // Can't have two applications for the same product — disable taken purposes.
  function disableUsedPurposes(apps, editing) {
    var used = {}; apps.forEach(function (a) { used[a.purpose] = true; });
    document.querySelectorAll('input[name=loanPurpose]').forEach(function (inp) {
      if (used[inp.value] && inp.value !== editing) {
        inp.disabled = true;
        var lbl = inp.closest('.choice'); if (lbl) { lbl.style.opacity = '.45'; lbl.title = 'You already have a ' + inp.value.replace('_', ' ') + ' application — edit it from your portal.'; }
        // if the (default) selected purpose is taken, move to the first free one
        if (inp.checked) {
          var free = Array.prototype.filter.call(document.querySelectorAll('input[name=loanPurpose]'), function (x) { return !used[x.value]; })[0];
          if (free) { free.checked = true; free.dispatchEvent(new Event('change', { bubbles: true })); }
        }
      }
    });
  }
  function offerAutofill() {
    var b = $('autofillBanner'); if (!b) return;
    b.style.display = '';
    $('autofillUse').onclick = function () {
      fetch('/api/profile', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var pr = (j && j.profile) || {};
          setVal('firstName', pr.firstName); setVal('lastName', pr.lastName);
          setVal('email', pr.email); setVal('phone', pr.phone); setVal('dob', pr.dob);
          setVal('curAddress', pr.currentAddress);
          setVal('income', pr.grossMonthlyIncome); setVal('creditScore', pr.creditScore);
          b.style.display = 'none';
          recompute();
        }).catch(function () { b.style.display = 'none'; });
    };
    $('autofillSkip').onclick = function () { b.style.display = 'none'; };
  }

  function prefillFromApplication(app) {
    editingExisting = true;
    var loan = app.loan || {}, prof = app.profile || {}, ctx = app.context || {};

    // Profile
    setVal('firstName', prof.firstName); setVal('lastName', prof.lastName);
    setVal('email', prof.email); setVal('phone', prof.phone); setVal('dob', prof.dob);
    setVal('curAddress', prof.currentAddress); setVal('desiredAddress', prof.desiredAddress);
    if (prof.ownRent) setRadio('ownRent', prof.ownRent);

    // Purpose / occupancy / ownership
    if (app.loanPurpose) { setRadio('loanPurpose', app.loanPurpose); state.loanPurpose = app.loanPurpose; }
    if (app.occupancy) { setRadio('occupancy', app.occupancy); state.occupancy = app.occupancy; }
    if (app.ownedRecently != null) { setRadio('ownedRecently', app.ownedRecently ? 'yes' : 'no'); state.ownedRecently = app.ownedRecently; }
    // Refinance fields
    if (app.refi) {
      state.refi = Object.assign({ value: 0, payoff: 0, type: 'rate_term', cashOut: 0, financeCosts: true }, app.refi);
      setVal('refiValue', state.refi.value); setVal('refiPayoff', state.refi.payoff); setVal('refiCashOut', state.refi.cashOut);
      setRadio('refiType', state.refi.type);
      if ($('refiFinanceCosts')) $('refiFinanceCosts').checked = state.refi.financeCosts !== false;
      var rzip = (app.context && app.context.lookingZip) || prof.lookingZip;
      if (rzip && $('refiZip')) $('refiZip').value = rzip;
    }

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

    // Debts, assets, properties owned
    state.debts = []; if ($('debtList')) $('debtList').innerHTML = '';
    (app.debts || []).forEach(function (d) { var c = Object.assign({}, d); state.debts.push(c); $('debtList').appendChild(debtRow(c)); });
    state.assets = []; if ($('assetList')) $('assetList').innerHTML = '';
    (app.assets || []).forEach(function (a) { var c = Object.assign({}, a); state.assets.push(c); $('assetList').appendChild(assetRow(c)); });
    state.reos = []; if ($('reoList')) $('reoList').innerHTML = '';
    (app.reos || []).forEach(function (p) { var c = Object.assign({}, p); state.reos.push(c); $('reoList').appendChild(propertyRow(c)); });

    // Rate selection + tax
    if (app.selectedRate) state.selectedRate = app.selectedRate;
    if (zip) { updateTax(); }
    else if (loan.taxRatePct) { state.taxRatePct = loan.taxRatePct; state.taxCounty = app.taxCounty || null; }

    if (isAuthed) { applyAuthedUI(); var btn = $('submitApp'); if (btn) btn.textContent = 'Save changes →'; }

    updateProgGrid(); updateOccupancyVisibility(); updatePurposeSections();
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
        if (name === 'loanPurpose') {
          var lp = document.querySelector('input[name=loanPurpose]:checked');
          state.loanPurpose = lp ? lp.value : 'purchase';
          // Purpose drives occupancy: investment→investment, second home→second,
          // purchase/refinance→primary (and the selector is shown for those).
          if (state.loanPurpose === 'investment') state.occupancy = 'investment';
          else if (state.loanPurpose === 'second_home') state.occupancy = 'second';
          else state.occupancy = 'primary';
          syncOccupancyRadios();
          updateOccupancyVisibility();
          updatePurposeSections();
          updateProgGrid();
        }
        if (name === 'occupancy') {
          var oc = document.querySelector('input[name=occupancy]:checked');
          state.occupancy = oc ? oc.value : 'primary';
          updateProgGrid();
        }
        if (name === 'ownedRecently') {
          var orr = document.querySelector('input[name=ownedRecently]:checked');
          state.ownedRecently = orr ? (orr.value === 'yes') : null;
          updateProgGrid();
        }
        if (name === 'refiType') {
          var rt = document.querySelector('input[name=refiType]:checked');
          state.refi.type = rt ? rt.value : 'rate_term';
          updateRefi();
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
  function syncOccupancyRadios() {
    var el = document.querySelector('input[name=occupancy][value="' + state.occupancy + '"]');
    if (el) { el.checked = true; var grp = el.closest('[data-choice]'); if (grp) grp.querySelectorAll('.choice').forEach(function (c) { var i = c.querySelector('input'); c.classList.toggle('sel', i && i.checked); }); }
  }
  function updateOccupancyVisibility() {
    var wrap = $('occupancyWrap');
    if (wrap) wrap.style.display = (state.loanPurpose === 'investment' || state.loanPurpose === 'second_home') ? 'none' : '';
  }
  // Show purchase fields vs refinance fields on the property step.
  function updatePurposeSections() {
    var refi = state.loanPurpose === 'refinance';
    var ps = $('purchaseSection'), rs = $('refiSection');
    if (ps) ps.style.display = refi ? 'none' : '';
    if (rs) rs.style.display = refi ? '' : 'none';
    var title = document.querySelector('.panel[data-step="2"] h2');
    if (title) title.textContent = refi ? 'Your current home & refinance' : 'The property & your down payment';
    if (refi) updateRefi();
  }
  // Refinance: equity, cash-out cap, LTV check, tax from ZIP, summary line.
  function updateRefi() {
    if (state.loanPurpose !== 'refinance') return;
    readRefiInputs();
    var cw = $('cashOutWrap'); if (cw) cw.style.display = state.refi.type === 'cash_out' ? '' : 'none';
    // tax from refi ZIP
    var zip = ($('refiZip') && $('refiZip').value.trim()) || '';
    if (zip.length === 5 && window.TexasTax) {
      var t = Tax.estimate(zip);
      if (t && t.ratePct) {
        state.taxRatePct = t.ratePct; state.taxCounty = t.county; state.taxSource = 'zip';
        var tr = $('refiTaxReadout'); if (tr) { tr.style.display = 'block'; tr.innerHTML = '✓ ' + t.county + ' County property tax ≈ <b>' + t.ratePct + '%</b>/yr — applied to your estimate.'; }
      }
    }
    var p = calcPayload(); var r = Calc.calculate(p);
    var eq = $('refiEquityNote');
    if (eq && state.refi.value > 0) {
      eq.style.display = 'block';
      eq.innerHTML = 'Equity: <b>' + fmt(r.equity) + '</b> · current LTV before refi ≈ <b>' +
        (state.refi.value ? Math.round(state.refi.payoff / state.refi.value * 100) : 0) + '%</b>.';
    } else if (eq) eq.style.display = 'none';
    // cash-out max
    var capPct = Calc.refiLtvCap(state.program, state.occupancy, state.refi.type);
    var maxCash = Math.max(0, Math.round(capPct * state.refi.value - state.refi.payoff));
    var cm = $('refiCashMax');
    if (cm) cm.innerHTML = state.refi.type === 'cash_out'
      ? 'Max cash-out at ' + Math.round(capPct * 100) + '% LTV ≈ <b>' + fmt(maxCash) + '</b>'
      : '';
    // LTV warning
    var w = $('refiLtvWarning');
    if (w) {
      if (r.ltvOver) { w.style.display = 'block'; w.innerHTML = '⚠️ New loan LTV is <b>' + r.ltv + '%</b>, above the <b>' + r.ltvCap + '%</b> max for this ' + (state.refi.type === 'cash_out' ? 'cash-out ' : '') + 'refinance. Reduce cash-out or choose another program.'; }
      else w.style.display = 'none';
    }
    // summary
    var s = $('refiSummary');
    if (s && state.refi.value > 0) {
      s.style.display = 'block';
      var line = 'New loan <b>' + fmt(r.baseLoan) + '</b> · LTV <b>' + r.ltv + '%</b> · new payment <b>' + fmt(r.totalMonthly) + '/mo</b>';
      if (state.refi.type === 'cash_out') line += ' · cash to you ≈ <b>' + fmt(r.cashToBorrower) + '</b>';
      else line += ' · cash to close ≈ <b>' + fmt(r.cashToClose) + '</b>';
      s.innerHTML = line;
    } else if (s) s.style.display = 'none';
  }

  /* ====== Exit guard ======
     Leaving the application discards unsaved entries (there is no auto-save), so
     intercept Home / brand clicks and confirm first. */
  function wireExitGuard() {
    var overlay = $('exitOverlay');
    if (!overlay) return;
    function openExit(e) {
      if (e) e.preventDefault();
      var msg = $('exitMsg');
      if (msg) {
        msg.textContent = isAuthed
          ? 'Any edits you have made since your last save will be lost. Your previously submitted application stays on file.'
          : "Your application isn't saved yet. If you leave now, the information you've entered will be deleted and you'll need to start over. There is no auto-save.";
      }
      var go = $('exitGo'); if (go) go.textContent = isAuthed ? 'Leave anyway' : 'Leave & delete';
      overlay.classList.add('open');
    }
    function closeExit() { overlay.classList.remove('open'); }
    document.querySelectorAll('[data-exit]').forEach(function (el) { el.addEventListener('click', openExit); });
    $('exitStay').addEventListener('click', closeExit);
    $('exitGo').addEventListener('click', function () { window.location.href = '/'; });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeExit(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay.classList.contains('open')) closeExit(); });
  }

  function init() {
    renderStepper();
    wireChoiceGroups();
    wireSSN('ssn', 'ssnToggle');
    wireSSN('coSsn', 'coSsnToggle');
    wireExitGuard();

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

    // Refinance inputs
    ['refiValue', 'refiPayoff', 'refiCashOut', 'refiZip', 'refiHoa'].forEach(function (id) {
      var e = $(id); if (e) e.addEventListener('input', recompute);
    });
    var rfc = $('refiFinanceCosts'); if (rfc) rfc.addEventListener('change', recompute);

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

    // First-time buyer is derived from the page-1 ownership question (no manual box).

    // Debt/asset/property rows
    $('addDebt').addEventListener('click', function () { var d = {}; state.debts.push(d); $('debtList').appendChild(debtRow(d)); });
    $('addAsset').addEventListener('click', function () { var a = {}; state.assets.push(a); $('assetList').appendChild(assetRow(a)); });
    var addProp = $('addProp');
    if (addProp) addProp.addEventListener('click', function () {
      var p = { disposition: 'keep' };
      // prefill the first property's address from the page-1 current address
      if (!state.reos.length && $('curAddress') && $('curAddress').value) p.address = $('curAddress').value;
      state.reos.push(p); $('reoList').appendChild(propertyRow(p)); renderReoSummary();
    });

    // Decision modal → portal
    var dGo = $('decisionGo'); if (dGo) dGo.addEventListener('click', closeDecisionToPortal);

    // Purpose note + occupancy visibility
    updateOccupancyVisibility();
    updatePurposeSections();

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
