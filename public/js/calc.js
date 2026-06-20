/* =============================================================================
 * calc.js  —  Mortgage qualification engine (Texas-focused)
 * -----------------------------------------------------------------------------
 * Pure functions, no DOM. Works in the browser (window.MortgageCalc) and in
 * Node (module.exports) so the same math powers the UI and the test suite.
 *
 * IMPORTANT: Everything here produces ESTIMATES for pre-qualification. It is not
 * a Loan Estimate (TILA/RESPA), not a commitment to lend, and not legal advice.
 * Program limits, MI factors, and fees are seeded with recent values and are
 * meant to be configured/overridden by a licensed lender.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MortgageCalc = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ===========================================================================
  // RULES — the single, configurable source of truth for program guidelines.
  // A lender/investor can override any of these at runtime via MortgageCalc
  // .configure({ ... }) without touching the engine code below. All values are
  // representative defaults; verify against current agency/investor guidelines.
  // ===========================================================================
  const RULES = {
    conformingLimit1Unit: 806500,   // 2025 baseline 1-unit conforming limit
    fhaFloor1Unit:        524225,   // 2025 FHA floor (most TX counties)

    insRate:      0.0060,           // TX homeowners ~0.6%/yr of value
    closingRate:  0.025,            // est. lender/title/3rd-party closing costs
    prepaidMonths: { ins: 3, tax: 3 },

    programLabel: {
      conventional: 'Conventional', conventional_fthb: 'Conventional (First-Time Buyer 97%)',
      fha: 'FHA', va: 'VA', usda: 'USDA Rural', jumbo: 'Jumbo', land: 'Land / Lot',
    },

    // Minimum down payment (fraction) by program × occupancy (purchase).
    minDown: {
      conventional:      { primary: 0.05, second: 0.10, investment: 0.15 },
      conventional_fthb: { primary: 0.03, second: 0.10, investment: 0.15 },
      fha:               { primary: 0.035, second: 0.035, investment: 0.035 },
      va:                { primary: 0.00, second: 0.00, investment: 0.00 },
      usda:              { primary: 0.00, second: 0.00, investment: 0.00 },
      jumbo:             { primary: 0.10, second: 0.20, investment: 0.25 },
      land:              { primary: 0.20, second: 0.20, investment: 0.20 },
    },
    fhaLowCreditThreshold: 580,     // < this → 10% down for FHA
    fhaLowCreditDown: 0.10,

    minCredit: { conventional: 620, conventional_fthb: 620, fha: 500, va: 580, usda: 600, jumbo: 700, land: 640 },

    // Max back-end DTI (fraction) by program.
    maxBackDTI: { conventional: 0.50, conventional_fthb: 0.50, fha: 0.569, va: 0.60, usda: 0.43, jumbo: 0.43, land: 0.43 },

    // Refinance max LTV (fraction) by program × type × occupancy.
    refiMaxLtv: {
      conventional: { rate_term: { primary: 0.95, second: 0.90, investment: 0.75 }, cash_out: { primary: 0.80, second: 0.75, investment: 0.75 } },
      fha:          { rate_term: { primary: 0.965, second: 0.965, investment: 0.965 }, cash_out: { primary: 0.80, second: 0.80, investment: 0.80 } },
      va:           { rate_term: { primary: 1.00, second: 1.00, investment: 1.00 }, cash_out: { primary: 0.90, second: 0.90, investment: 0.90 } },
      jumbo:        { rate_term: { primary: 0.90, second: 0.80, investment: 0.75 }, cash_out: { primary: 0.80, second: 0.75, investment: 0.70 } },
      usda:         { rate_term: { primary: 1.00, second: 1.00, investment: 1.00 }, cash_out: { primary: 0.00, second: 0.00, investment: 0.00 } },
    },

    // Conventional PMI annual factors (% of loan/yr) by LTV band & credit tier.
    pmiTable: [
      { ltv: 0.85, f: { 760: 0.0014, 740: 0.0016, 720: 0.0020, 700: 0.0026, 680: 0.0030, 660: 0.0044, 640: 0.0058, 620: 0.0070 } },
      { ltv: 0.90, f: { 760: 0.0019, 740: 0.0023, 720: 0.0030, 700: 0.0041, 680: 0.0052, 660: 0.0078, 640: 0.0098, 620: 0.0114 } },
      { ltv: 0.95, f: { 760: 0.0030, 740: 0.0038, 720: 0.0051, 700: 0.0070, 680: 0.0086, 660: 0.0118, 640: 0.0150, 620: 0.0170 } },
      { ltv: 1.00, f: { 760: 0.0058, 740: 0.0070, 720: 0.0087, 700: 0.0110, 680: 0.0128, 660: 0.0162, 640: 0.0194, 620: 0.0220 } },
    ],

    fha:  { ufmip: 0.0175, annualHighLtv: 0.0055, annualLowLtv: 0.0050, ltvBreak: 0.95 },
    usda: { upfront: 0.0100, annual: 0.0035 },

    // VA funding fee (% of base loan). Purchase by use × down band; refinance by
    // type (IRRRL streamline vs cash-out). Exempt for service-connected disability.
    va: {
      purchase: {
        first:      [ { downMin: 0.10, fee: 0.0125 }, { downMin: 0.05, fee: 0.0150 }, { downMin: 0.00, fee: 0.0215 } ],
        subsequent: [ { downMin: 0.10, fee: 0.0125 }, { downMin: 0.05, fee: 0.0150 }, { downMin: 0.00, fee: 0.0330 } ],
      },
      irrrl: 0.005,                          // VA streamline (rate/term) refinance
      cashout: { first: 0.0215, subsequent: 0.0330 },
    },
  };

  // Deep-merge overrides into RULES (lets a lender plug in their own rate card).
  function configure(overrides) {
    (function merge(dst, src) {
      Object.keys(src || {}).forEach(function (k) {
        if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) merge(dst[k], src[k]);
        else dst[k] = src[k];
      });
    })(RULES, overrides || {});
    return RULES;
  }

  const DEFAULT_PREPAID_MONTHS_INS = RULES.prepaidMonths.ins;
  const DEFAULT_PREPAID_MONTHS_TAX = RULES.prepaidMonths.tax;

  // ---------------------------------------------------------------------------
  function round(n, d) { const p = Math.pow(10, d || 0); return Math.round((+n || 0) * p) / p; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  /** Monthly principal & interest via standard amortization. */
  function principalAndInterest(loanAmount, annualRatePct, termYears) {
    const n = termYears * 12;
    const r = (annualRatePct / 100) / 12;
    if (loanAmount <= 0) return 0;
    if (r === 0) return loanAmount / n;
    return loanAmount * (r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  }

  /** Conventional monthly PMI (0 if LTV<=80%). */
  function conventionalPMI(baseLoan, ltv, creditScore) {
    if (ltv <= 0.80) return 0;
    const band = RULES.pmiTable.find(b => ltv <= b.ltv) || RULES.pmiTable[RULES.pmiTable.length - 1];
    const tiers = [760, 740, 720, 700, 680, 660, 640, 620];
    let factor = band.f[620];
    for (const t of tiers) { if (creditScore >= t) { factor = band.f[t]; break; } }
    return (baseLoan * factor) / 12;
  }

  /** Pick the right upfront/annual MI for the program. Returns {upfrontPct, annualPct, financedUpfront}.
   *  vaPurpose: 'purchase' (default) | 'irrrl' (streamline refi) | 'cashout'. */
  function mortgageInsuranceForProgram(program, ltv, downPct, creditScore, vaUse, vaExempt, vaPurpose) {
    switch (program) {
      case 'fha':
        return { upfrontPct: RULES.fha.ufmip, annualPct: ltv > RULES.fha.ltvBreak ? RULES.fha.annualHighLtv : RULES.fha.annualLowLtv, financedUpfront: true };
      case 'usda':
        return { upfrontPct: RULES.usda.upfront, annualPct: RULES.usda.annual, financedUpfront: true };
      case 'va': {
        if (vaExempt) return { upfrontPct: 0, annualPct: 0, financedUpfront: true };
        let fee;
        if (vaPurpose === 'irrrl') fee = RULES.va.irrrl;
        else if (vaPurpose === 'cashout') fee = vaUse === 'subsequent' ? RULES.va.cashout.subsequent : RULES.va.cashout.first;
        else {
          const table = vaUse === 'subsequent' ? RULES.va.purchase.subsequent : RULES.va.purchase.first;
          const row = table.find(t => downPct >= t.downMin) || table[table.length - 1];
          fee = row.fee;
        }
        return { upfrontPct: fee, annualPct: 0, financedUpfront: true };
      }
      default: // conventional, conventional_fthb, jumbo, land
        return { upfrontPct: 0, annualPct: 0, financedUpfront: false };
    }
  }

  /**
   * Core calculation. Takes a flat input object and returns every figure the
   * underwriting bar and the application need.
   */
  function calculate(input) {
    const i = input || {};
    if ((i.mode || i.loanPurpose) === 'refinance') return calculateRefi(i);
    const program     = i.program || 'conventional';
    const price        = +i.purchasePrice || 0;
    const downPct      = clamp((+i.downPaymentPct || 0) / 100, 0, 1);
    const ratePct      = +i.interestRate || 0;
    const termYears    = +i.termYears || 30;
    const creditScore  = +i.creditScore || 0;
    const grossMonthly = +i.grossMonthlyIncome || 0;
    const monthlyDebts = +i.monthlyDebts || 0;
    const hoaMonthly   = +i.hoaMonthly || 0;
    const vaUse        = i.vaUse || 'first';
    const vaExempt     = !!i.vaFundingFeeExempt;

    const downPayment  = round(price * downPct, 2);
    const baseLoan     = round(price - downPayment, 2);
    const ltv          = price > 0 ? baseLoan / price : 0;

    // Mortgage insurance / guarantee/funding fees
    const mi = mortgageInsuranceForProgram(program, ltv, downPct, creditScore, vaUse, vaExempt);
    const upfrontFee = round(baseLoan * mi.upfrontPct, 2);          // UFMIP / VA fee / USDA upfront
    const financedFee = mi.financedUpfront ? upfrontFee : 0;
    const totalLoan = round(baseLoan + financedFee, 2);            // amount actually amortized

    // Monthly MI
    let monthlyMI = 0;
    if (program === 'fha' || program === 'usda') {
      monthlyMI = round((totalLoan * mi.annualPct) / 12, 2);
    } else if (program === 'va') {
      monthlyMI = 0;
    } else {
      monthlyMI = round(conventionalPMI(baseLoan, ltv, creditScore), 2);
    }

    // Taxes & insurance
    const annualTax = i.annualPropertyTax != null
      ? +i.annualPropertyTax
      : round(price * ((+i.taxRatePct || 0) / 100), 2);
    const monthlyTax = round(annualTax / 12, 2);

    const annualInsurance = i.annualHomeInsurance != null
      ? +i.annualHomeInsurance
      : round(price * RULES.insRate, 2);
    const monthlyInsurance = round(annualInsurance / 12, 2);

    const pi = round(principalAndInterest(totalLoan, ratePct, termYears), 2);
    const piti = round(pi + monthlyTax + monthlyInsurance, 2);
    const totalMonthly = round(piti + monthlyMI + hoaMonthly, 2);

    // DTI
    const frontDTI = grossMonthly > 0 ? round((totalMonthly / grossMonthly) * 100, 1) : 0;
    const backDTI  = grossMonthly > 0 ? round(((totalMonthly + monthlyDebts) / grossMonthly) * 100, 1) : 0;

    // Cash to close
    const closingCosts = i.closingCosts != null ? +i.closingCosts : round(price * RULES.closingRate, 2);
    const prepaids = round(
      monthlyInsurance * DEFAULT_PREPAID_MONTHS_INS + monthlyTax * DEFAULT_PREPAID_MONTHS_TAX, 2);
    const sellerCredits = +i.sellerCredits || 0;
    const lenderCredits = +i.lenderCredits || 0;
    const dpaAmount     = +i.dpaAmount || 0; // down-payment assistance applied to cash
    const earnestMoney  = +i.earnestMoneyPaid || 0; // already paid, reduces remaining cash
    // Discount points to buy down the rate are paid at closing. `discountPoints`
    // is in points (1 = 1% of the loan). Positive = cost (adds to cash to close);
    // negative = lender credit (reduces it).
    const discountPoints = +i.discountPoints || 0;
    const pointsCost = round(totalLoan * (discountPoints / 100), 2);
    const cashToClose = round(
      downPayment + closingCosts + prepaids + pointsCost
      - sellerCredits - lenderCredits - dpaAmount - earnestMoney, 2);

    return {
      program, price, downPct: round(downPct * 100, 3), downPayment,
      baseLoan, financedFee, upfrontFee, totalLoan, ltv: round(ltv * 100, 2),
      pi, monthlyTax, monthlyInsurance, monthlyMI, hoaMonthly,
      piti, totalMonthly,
      frontDTI, backDTI,
      annualTax, annualInsurance,
      closingCosts, prepaids, dpaAmount, sellerCredits, lenderCredits,
      discountPoints, pointsCost,
      cashToClose: Math.max(0, cashToClose),
    };
  }

  /** Max LTV for a refinance by program, occupancy, and type (rate/term vs cash-out). */
  function refiLtvCap(program, occupancy, type) {
    const occ = (occupancy === 'second' || occupancy === 'investment') ? occupancy : 'primary';
    const t = type === 'cash_out' ? 'cash_out' : 'rate_term';
    const byProgram = RULES.refiMaxLtv[program] || RULES.refiMaxLtv.conventional;
    const byType = byProgram[t] || byProgram.rate_term;
    return byType[occ] != null ? byType[occ] : byType.primary;
  }

  /** Refinance calculation: loan is built from payoff + cash-out, LTV vs home value. */
  function calculateRefi(i) {
    const program     = i.program || 'conventional';
    const homeValue   = +i.homeValue || 0;
    const payoff      = +i.payoff || 0;
    const type        = i.refiType === 'cash_out' ? 'cash_out' : 'rate_term';
    const cashOut     = type === 'cash_out' ? Math.max(0, +i.cashOut || 0) : 0;
    const financeCosts = !!i.financeClosingCosts;
    const ratePct     = +i.interestRate || 0;
    const termYears   = +i.termYears || 30;
    const creditScore = +i.creditScore || 0;
    const grossMonthly = +i.grossMonthlyIncome || 0;
    const monthlyDebts = +i.monthlyDebts || 0;
    const hoaMonthly   = +i.hoaMonthly || 0;
    const occupancy    = i.occupancy || 'primary';
    const discountPoints = +i.discountPoints || 0;

    const equity = round(homeValue - payoff, 2);
    // Estimated closing costs based on the financing being arranged.
    const prelimLoan = payoff + cashOut;
    const closingCosts = i.closingCosts != null ? +i.closingCosts : round(prelimLoan * RULES.closingRate, 2);
    const financedCosts = financeCosts ? closingCosts : 0;
    const baseLoan = round(prelimLoan + financedCosts, 2);
    const ltv = homeValue > 0 ? baseLoan / homeValue : 0;
    const downPctEquiv = clamp(1 - ltv, 0, 1); // equity stake, drives MI/VA-fee tables

    const mi = mortgageInsuranceForProgram(program, ltv, downPctEquiv, creditScore, i.vaUse || 'subsequent', !!i.vaFundingFeeExempt, type === 'cash_out' ? 'cashout' : 'irrrl');
    const upfrontFee = round(baseLoan * mi.upfrontPct, 2);
    const financedFee = mi.financedUpfront ? upfrontFee : 0;
    const totalLoan = round(baseLoan + financedFee, 2);

    let monthlyMI = 0;
    if (program === 'fha' || program === 'usda') monthlyMI = round((totalLoan * mi.annualPct) / 12, 2);
    else if (program === 'va') monthlyMI = 0;
    else monthlyMI = round(conventionalPMI(baseLoan, ltv, creditScore), 2);

    const annualTax = i.annualPropertyTax != null ? +i.annualPropertyTax : round(homeValue * ((+i.taxRatePct || 0) / 100), 2);
    const monthlyTax = round(annualTax / 12, 2);
    const annualInsurance = i.annualHomeInsurance != null ? +i.annualHomeInsurance : round(homeValue * RULES.insRate, 2);
    const monthlyInsurance = round(annualInsurance / 12, 2);

    const pi = round(principalAndInterest(totalLoan, ratePct, termYears), 2);
    const piti = round(pi + monthlyTax + monthlyInsurance, 2);
    const totalMonthly = round(piti + monthlyMI + hoaMonthly, 2);

    const frontDTI = grossMonthly > 0 ? round((totalMonthly / grossMonthly) * 100, 1) : 0;
    const backDTI  = grossMonthly > 0 ? round(((totalMonthly + monthlyDebts) / grossMonthly) * 100, 1) : 0;

    const prepaids = round(monthlyInsurance * DEFAULT_PREPAID_MONTHS_INS + monthlyTax * DEFAULT_PREPAID_MONTHS_TAX, 2);
    const pointsCost = round(totalLoan * (discountPoints / 100), 2);
    const outOfPocket = round((financeCosts ? 0 : closingCosts) + prepaids + pointsCost, 2);
    // Net cash position: positive = borrower receives money; negative = brings money.
    const netCash = round(cashOut - outOfPocket, 2);
    const cashToBorrower = Math.max(0, netCash);
    const cashToClose = Math.max(0, -netCash);

    const cap = refiLtvCap(program, occupancy, type);

    return {
      mode: 'refinance', program, refiType: type,
      price: homeValue, homeValue, payoff, equity, cashOut,
      downPayment: 0, downPct: round(downPctEquiv * 100, 2),
      baseLoan, financedFee, upfrontFee, totalLoan, ltv: round(ltv * 100, 2), ltvCap: round(cap * 100, 1),
      ltvOver: ltv > cap + 1e-9,
      pi, monthlyTax, monthlyInsurance, monthlyMI, hoaMonthly, piti, totalMonthly,
      frontDTI, backDTI, annualTax, annualInsurance,
      closingCosts, prepaids, financedCosts, discountPoints, pointsCost,
      netCash, cashToBorrower, cashToClose,
    };
  }

  // --- Program rule checks: minimum down, eligibility flags, qualification ----
  // Minimum down (fraction) for a program given occupancy + credit (FHA credit rule).
  function minDown(program, occupancy, creditScore) {
    const occ = (occupancy === 'second' || occupancy === 'investment') ? occupancy : 'primary';
    const byProg = RULES.minDown[program] || RULES.minDown.conventional;
    let d = byProg[occ] != null ? byProg[occ] : byProg.primary;
    if (program === 'fha' && (+creditScore || 0) > 0 && (+creditScore) < RULES.fhaLowCreditThreshold) d = Math.max(d, RULES.fhaLowCreditDown);
    return d;
  }
  function maxBackDTIFor(program) { return Math.round((RULES.maxBackDTI[program] != null ? RULES.maxBackDTI[program] : 0.50) * 1000) / 10; }
  function programLabel(program) { return RULES.programLabel[program] || 'Conventional'; }

  function programRules(program, ctx) {
    const c = ctx || {};
    const fthb = !!c.firstTimeBuyer;
    const credit = +c.creditScore || 0;
    const occ = c.occupancy || 'primary';
    const r = {
      minDown: minDown(program, occ, credit),
      label: programLabel(program),
      minCredit: RULES.minCredit[program] != null ? RULES.minCredit[program] : 620,
    };
    // 3% conventional path requires first-time-buyer status
    if (program === 'conventional_fthb' && !fthb) {
      r.minDown = minDown('conventional', occ, credit);
      r.note = 'Not flagged first-time buyer — minimum reverts to the standard conventional down payment.';
    }
    return r;
  }

  /** Conforming/jumbo boundary helper. */
  function isJumbo(loanAmount, countyLimit) {
    return loanAmount > (countyLimit || RULES.conformingLimit1Unit);
  }

  /** Overall pre-qual verdict with reasons (advisory only). */
  function qualify(result, ctx) {
    const c = ctx || {};
    const reasons = [];
    const maxBackDTI = c.maxBackDTI || maxBackDTIFor(result.program);
    const rule = programRules(result.program, c);

    if (result.mode === 'refinance') {
      // Refinance: check LTV against the program/occupancy/type cap.
      if (result.ltvOver) {
        reasons.push(`Loan-to-value ${result.ltv}% exceeds the ${result.ltvCap}% maximum for this ${result.refiType === 'cash_out' ? 'cash-out ' : ''}${rule.label} refinance.`);
      }
    } else {
      if (result.downPct / 100 + 1e-9 < rule.minDown) {
        reasons.push(`Down payment ${result.downPct}% is below the ${Math.round(rule.minDown * 100)}% minimum for ${rule.label}.`);
      }
      if (result.program === 'land' && result.downPct < 20) {
        reasons.push('Land/lot loans generally require at least 20% down.');
      }
    }
    if ((c.creditScore || 0) < rule.minCredit) {
      reasons.push(`Credit score ${c.creditScore || 'n/a'} is below ${rule.minCredit} typical for ${rule.label}.`);
    }
    if (result.backDTI > maxBackDTI) {
      reasons.push(`Back-end DTI ${result.backDTI}% exceeds ~${maxBackDTI}% guideline.`);
    }
    if ((result.program === 'conventional' || result.program === 'conventional_fthb' || result.program === 'jumbo')
        && isJumbo(result.baseLoan, c.countyConformingLimit) && result.program !== 'jumbo') {
      reasons.push(`Loan of $${Math.round(result.baseLoan).toLocaleString()} exceeds the conforming limit — this is a Jumbo loan.`);
    }
    return { eligible: reasons.length === 0, reasons, maxBackDTI };
  }

  /**
   * Max purchase price the borrower can afford given a target back-end DTI.
   * Solves iteratively because taxes/insurance/MI scale with price.
   */
  function maxAffordablePrice(ctx) {
    const c = ctx || {};
    const grossMonthly = +c.grossMonthlyIncome || 0;
    const monthlyDebts = +c.monthlyDebts || 0;
    const targetDTI = (c.maxBackDTI || 45) / 100;
    const budget = grossMonthly * targetDTI - monthlyDebts;
    if (budget <= 0) return 0;

    let lo = 0, hi = 5000000;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const r = calculate(Object.assign({}, c, { purchasePrice: mid }));
      if (r.totalMonthly + monthlyDebts > grossMonthly * targetDTI) hi = mid; else lo = mid;
    }
    return round(lo, 0);
  }

  return {
    calculate, calculateRefi, refiLtvCap, principalAndInterest, conventionalPMI, programRules,
    qualify, maxAffordablePrice, isJumbo, mortgageInsuranceForProgram,
    minDown, maxBackDTIFor, programLabel,
    RULES, configure,
    CONST: { CONFORMING_LIMIT_1UNIT: RULES.conformingLimit1Unit, FHA_FLOOR_1UNIT: RULES.fhaFloor1Unit,
             FHA_UFMIP: RULES.fha.ufmip, FHA_ANNUAL_MIP: RULES.fha.annualHighLtv,
             USDA_ANNUAL: RULES.usda.annual, DEFAULT_INS_RATE: RULES.insRate, DEFAULT_CLOSING_RATE: RULES.closingRate },
  };
}));
