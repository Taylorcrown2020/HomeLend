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

  // --- Program constants (CONFIGURABLE — verify against current guidelines) ---
  const CONFORMING_LIMIT_1UNIT = 806500;   // 2025 baseline 1-unit conforming limit
  const FHA_FLOOR_1UNIT        = 524225;   // 2025 FHA floor (most TX counties)
  // High-cost TX counties (e.g. parts of Austin metro) can exceed the floor;
  // override per-county in production via the loan-limits table.

  const FED_POVERTY_NONE = 0; // placeholder hook

  // Conventional PMI annual factors (% of loan/yr) by LTV band & credit tier.
  // Rough industry table; real factors come from the MI provider's rate card.
  const PMI_TABLE = [
    // ltvMax, {760:.., 740:.., 720:.., 700:.., 680:.., 660:.., 640:.., 620:..}
    { ltv: 0.85, f: { 760: 0.0014, 740: 0.0016, 720: 0.0020, 700: 0.0026, 680: 0.0030, 660: 0.0044, 640: 0.0058, 620: 0.0070 } },
    { ltv: 0.90, f: { 760: 0.0019, 740: 0.0023, 720: 0.0030, 700: 0.0041, 680: 0.0052, 660: 0.0078, 640: 0.0098, 620: 0.0114 } },
    { ltv: 0.95, f: { 760: 0.0030, 740: 0.0038, 720: 0.0051, 700: 0.0070, 680: 0.0086, 660: 0.0118, 640: 0.0150, 620: 0.0170 } },
    { ltv: 1.00, f: { 760: 0.0058, 740: 0.0070, 720: 0.0087, 700: 0.0110, 680: 0.0128, 660: 0.0162, 640: 0.0194, 620: 0.0220 } },
  ];

  // VA funding fee (% of base loan), first vs subsequent use, by down payment.
  // Regular military; exempt if service-connected disability.
  const VA_FUNDING_FEE = {
    first:      [ { downMin: 0.10, fee: 0.0125 }, { downMin: 0.05, fee: 0.0150 }, { downMin: 0.00, fee: 0.0215 } ],
    subsequent: [ { downMin: 0.10, fee: 0.0125 }, { downMin: 0.05, fee: 0.0150 }, { downMin: 0.00, fee: 0.0330 } ],
  };

  const FHA_UFMIP = 0.0175;          // financed into loan
  const FHA_ANNUAL_MIP = 0.0055;     // 30yr, LTV>95%, post-2023 (most cases)
  const FHA_ANNUAL_MIP_LOW = 0.0050; // 30yr, LTV<=95%
  const USDA_UPFRONT = 0.0100;       // guarantee fee, financed
  const USDA_ANNUAL  = 0.0035;       // annual fee on balance

  const DEFAULT_INS_RATE = 0.0060;   // TX homeowners ~0.6%/yr of price (high vs national)
  const DEFAULT_CLOSING_RATE = 0.025;// est. lender/title/3rd-party closing costs (% price)
  const DEFAULT_PREPAID_MONTHS_INS = 3; // escrow cushion months
  const DEFAULT_PREPAID_MONTHS_TAX = 3;

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
    const band = PMI_TABLE.find(b => ltv <= b.ltv) || PMI_TABLE[PMI_TABLE.length - 1];
    const tiers = [760, 740, 720, 700, 680, 660, 640, 620];
    let factor = band.f[620];
    for (const t of tiers) { if (creditScore >= t) { factor = band.f[t]; break; } }
    return (baseLoan * factor) / 12;
  }

  /** Pick the right upfront/annual MI for the program. Returns {upfrontPct, annualPct, financedUpfront}. */
  function mortgageInsuranceForProgram(program, ltv, downPct, creditScore, vaUse, vaExempt) {
    switch (program) {
      case 'fha':
        return { upfrontPct: FHA_UFMIP, annualPct: ltv > 0.95 ? FHA_ANNUAL_MIP : FHA_ANNUAL_MIP_LOW, financedUpfront: true };
      case 'usda':
        return { upfrontPct: USDA_UPFRONT, annualPct: USDA_ANNUAL, financedUpfront: true };
      case 'va': {
        if (vaExempt) return { upfrontPct: 0, annualPct: 0, financedUpfront: true };
        const table = vaUse === 'subsequent' ? VA_FUNDING_FEE.subsequent : VA_FUNDING_FEE.first;
        const row = table.find(t => downPct >= t.downMin) || table[table.length - 1];
        return { upfrontPct: row.fee, annualPct: 0, financedUpfront: true };
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
      : round(price * DEFAULT_INS_RATE, 2);
    const monthlyInsurance = round(annualInsurance / 12, 2);

    const pi = round(principalAndInterest(totalLoan, ratePct, termYears), 2);
    const piti = round(pi + monthlyTax + monthlyInsurance, 2);
    const totalMonthly = round(piti + monthlyMI + hoaMonthly, 2);

    // DTI
    const frontDTI = grossMonthly > 0 ? round((totalMonthly / grossMonthly) * 100, 1) : 0;
    const backDTI  = grossMonthly > 0 ? round(((totalMonthly + monthlyDebts) / grossMonthly) * 100, 1) : 0;

    // Cash to close
    const closingCosts = i.closingCosts != null ? +i.closingCosts : round(price * DEFAULT_CLOSING_RATE, 2);
    const prepaids = round(
      monthlyInsurance * DEFAULT_PREPAID_MONTHS_INS + monthlyTax * DEFAULT_PREPAID_MONTHS_TAX, 2);
    const sellerCredits = +i.sellerCredits || 0;
    const lenderCredits = +i.lenderCredits || 0;
    const dpaAmount     = +i.dpaAmount || 0; // down-payment assistance applied to cash
    const earnestMoney  = +i.earnestMoneyPaid || 0; // already paid, reduces remaining cash
    const cashToClose = round(
      downPayment + closingCosts + prepaids
      - sellerCredits - lenderCredits - dpaAmount - earnestMoney, 2);

    return {
      program, price, downPct: round(downPct * 100, 3), downPayment,
      baseLoan, financedFee, upfrontFee, totalLoan, ltv: round(ltv * 100, 2),
      pi, monthlyTax, monthlyInsurance, monthlyMI, hoaMonthly,
      piti, totalMonthly,
      frontDTI, backDTI,
      annualTax, annualInsurance,
      closingCosts, prepaids, dpaAmount, sellerCredits, lenderCredits,
      cashToClose: Math.max(0, cashToClose),
    };
  }

  // --- Program rule checks: minimum down, eligibility flags, qualification ----
  function programRules(program, ctx) {
    const c = ctx || {};
    const fthb = !!c.firstTimeBuyer;
    const credit = +c.creditScore || 0;
    const rules = {
      conventional:      { minDown: 0.05, label: 'Conventional', minCredit: 620 },
      conventional_fthb: { minDown: 0.03, label: 'Conventional (First-Time Buyer 97%)', minCredit: 620 },
      fha:               { minDown: credit >= 580 ? 0.035 : 0.10, label: 'FHA', minCredit: 500 },
      va:                { minDown: 0.00, label: 'VA', minCredit: 580 },
      usda:              { minDown: 0.00, label: 'USDA Rural', minCredit: 600 },
      jumbo:             { minDown: 0.10, label: 'Jumbo', minCredit: 700 },
      land:              { minDown: 0.20, label: 'Land / Lot', minCredit: 640 },
    };
    const r = rules[program] || rules.conventional;
    // 3% conventional path requires first-time-buyer status
    if (program === 'conventional_fthb' && !fthb) {
      r.minDown = 0.05;
      r.note = 'Not flagged first-time buyer — minimum reverts to 5%.';
    }
    return r;
  }

  /** Conforming/jumbo boundary helper. */
  function isJumbo(loanAmount, countyLimit) {
    return loanAmount > (countyLimit || CONFORMING_LIMIT_1UNIT);
  }

  /** Overall pre-qual verdict with reasons (advisory only). */
  function qualify(result, ctx) {
    const c = ctx || {};
    const reasons = [];
    const maxBackDTI = c.maxBackDTI || (result.program === 'fha' ? 56.9 : result.program === 'va' ? 60 : 50);
    const rule = programRules(result.program, c);

    if (result.downPct / 100 + 1e-9 < rule.minDown) {
      reasons.push(`Down payment ${result.downPct}% is below the ${Math.round(rule.minDown*100)}% minimum for ${rule.label}.`);
    }
    if ((c.creditScore || 0) < rule.minCredit) {
      reasons.push(`Credit score ${c.creditScore || 'n/a'} is below ${rule.minCredit} typical for ${rule.label}.`);
    }
    if (result.backDTI > maxBackDTI) {
      reasons.push(`Back-end DTI ${result.backDTI}% exceeds ~${maxBackDTI}% guideline.`);
    }
    if (result.program === 'land' && result.downPct < 20) {
      reasons.push('Land/lot loans generally require at least 20% down.');
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
    calculate, principalAndInterest, conventionalPMI, programRules,
    qualify, maxAffordablePrice, isJumbo, mortgageInsuranceForProgram,
    CONST: { CONFORMING_LIMIT_1UNIT, FHA_FLOOR_1UNIT, FHA_UFMIP, FHA_ANNUAL_MIP,
             USDA_ANNUAL, DEFAULT_INS_RATE, DEFAULT_CLOSING_RATE },
  };
}));
