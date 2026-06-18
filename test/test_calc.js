/* test/test_calc.js — sanity tests for the underwriting engine.
   Run: npm run test:calc   (no test framework needed) */
const Calc = require('../public/js/calc.js');
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }
function approx(a, b, tol) { return Math.abs(a - b) <= (tol || 1); }

// P&I: $300k @ 6.75% / 30yr ≈ $1,945.79
ok('P&I 300k/6.75/30', approx(Calc.principalAndInterest(300000, 6.75, 30), 1945.79, 1));
// P&I zero-rate = principal / months
ok('P&I zero rate', approx(Calc.principalAndInterest(360000, 0, 30), 1000, 0.01));

// Jumbo detection above conforming limit
ok('jumbo detect', Calc.isJumbo(900000) === true);
ok('not jumbo', Calc.isJumbo(500000) === false);

// Program min downs (minDown is a fraction: 0.05 = 5%)
ok('conv 5% min', Calc.programRules('conventional', {}).minDown === 0.05);
ok('conv fthb 3%', Calc.programRules('conventional_fthb', { firstTimeBuyer: true }).minDown === 0.03);
ok('conv fthb reverts', Calc.programRules('conventional_fthb', { firstTimeBuyer: false }).minDown === 0.05);
ok('fha 3.5 @580', Calc.programRules('fha', { creditScore: 600 }).minDown === 0.035);
ok('fha 10 @ <580', Calc.programRules('fha', { creditScore: 540 }).minDown === 0.10);
ok('va 0', Calc.programRules('va', {}).minDown === 0);
ok('usda 0', Calc.programRules('usda', {}).minDown === 0);
ok('land 20', Calc.programRules('land', {}).minDown === 0.20);

// Full calculate sanity
const r = Calc.calculate({
  program: 'conventional', purchasePrice: 400000, downPaymentPct: 20,
  interestRate: 6.75, termYears: 30, creditScore: 760,
  grossMonthlyIncome: 9000, monthlyDebts: 500, hoaMonthly: 0, taxRatePct: 1.9
});
ok('ltv 80 at 20down', approx(r.ltv, 80, 0.1));
ok('no PMI at 80 ltv', r.monthlyMI === 0);
ok('piti positive', r.piti > 0);
ok('frontDTI computed', r.frontDTI > 0 && r.frontDTI < 100);
ok('cashToClose positive', r.cashToClose > 0);

// PMI present below 20% down on conventional
const r2 = Calc.calculate({
  program: 'conventional', purchasePrice: 400000, downPaymentPct: 5,
  interestRate: 6.875, termYears: 30, creditScore: 740,
  grossMonthlyIncome: 9000, monthlyDebts: 500, hoaMonthly: 0, taxRatePct: 1.9
});
ok('PMI present <20%', r2.monthlyMI > 0);

// VA has no monthly MI but a funding fee
const rva = Calc.calculate({
  program: 'va', purchasePrice: 400000, downPaymentPct: 0,
  interestRate: 6.375, termYears: 30, creditScore: 720,
  grossMonthlyIncome: 9000, monthlyDebts: 400, hoaMonthly: 0, taxRatePct: 1.9,
  vaUse: 'first', vaFundingFeeExempt: false
});
ok('VA no monthly MI', rva.monthlyMI === 0);
ok('VA funding fee financed', rva.totalLoan >= rva.baseLoan);

// max affordable solver returns a sane positive number
const maxP = Calc.maxAffordablePrice({
  program: 'conventional', downPaymentPct: 5, interestRate: 6.75, termYears: 30,
  creditScore: 740, grossMonthlyIncome: 9000, monthlyDebts: 500, hoaMonthly: 0,
  taxRatePct: 1.9, maxBackDTI: 45
});
ok('max affordable > 0', maxP > 0 && maxP < 5000000);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
