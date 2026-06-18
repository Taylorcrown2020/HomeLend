/* numberbar.js — shared, persistent "your numbers" strip that sits under the nav
   on logged-in pages (client portal + find-a-home dashboard). Pure display:
   callers hand it the already-computed figures. It color-grades DTI against the
   program's typical back-end limit so the borrower always sees, at a glance,
   their estimated payment, ratios, LTV, cash to close, and qualified ceiling. */
(function (root) {
  'use strict';
  var MAX_BACK = { fha: 56.9, va: 60, usda: 43, conventional: 50, conventional_fthb: 50, jumbo: 43, land: 43 };
  var PROG_LABEL = { conventional: 'Conventional', conventional_fthb: 'Conventional 97 (FTHB)', fha: 'FHA', va: 'VA', usda: 'USDA', jumbo: 'Jumbo', land: 'Land / Lot' };
  var usd = function (n) { return '$' + Math.round(n || 0).toLocaleString('en-US'); };

  function dtiTag(val, kind, maxBack) {
    var cls = kind === 'front'
      ? (val <= 28 ? 'good' : val <= 36 ? 'warn' : 'bad')
      : (val <= maxBack * 0.75 ? 'good' : val <= maxBack ? 'warn' : 'bad');
    return '<span class="tag ' + cls + '">' + cls.toUpperCase() + '</span>';
  }
  function ksm(label, value) {
    return '<div class="ksm"><span class="l">' + label + '</span><span class="v">' + value + '</span></div>';
  }

  /* render(el, data)
     data = {
       program, programLabel?, contextLabel (html), taxLabel?,
       income (bool — whether DTI/cash is meaningful),
       numbers: { totalMonthly, frontDTI, backDTI, ltv, cashToClose },
       qualifiedUpTo?, clear?: function|null,
       prompt?: string (renders a gold prompt strip instead of metrics)
     }  */
  function render(el, data) {
    if (!el) return;
    if (!data || data.prompt) {
      el.className = 'ksbar ks-prompt';
      el.innerHTML = '<div class="ksbar-inner">' + ((data && data.prompt) ||
        'Finish your application to see your estimated payment, DTI, and cash to close here.') + '</div>';
      el.style.display = '';
      return;
    }
    el.className = 'ksbar';
    var n = data.numbers || {};
    var prog = data.program || 'conventional';
    var maxBack = MAX_BACK[prog] || 50;
    var income = data.income !== false;
    var progLabel = data.programLabel || PROG_LABEL[prog] || prog;

    var ctx = '<div class="ks-ctx"><b>' + progLabel + '</b>' +
      (data.contextLabel ? ' · ' + data.contextLabel : '') +
      (data.taxLabel ? ' · tax ' + data.taxLabel : '') + '</div>';

    var metrics =
      ksm('Est. payment', usd(n.totalMonthly) + '<small>/mo</small>') +
      ksm('Front DTI', (income ? n.frontDTI + '%' : '—') + (income ? ' ' + dtiTag(n.frontDTI, 'front', maxBack) : '')) +
      ksm('Back DTI', (income ? n.backDTI + '%' : '—') + (income ? ' ' + dtiTag(n.backDTI, 'back', maxBack) : '')) +
      ksm('LTV', (n.ltv != null ? n.ltv + '%' : '—')) +
      ksm('Cash to close', usd(n.cashToClose)) +
      (data.qualifiedUpTo ? ksm('Qualified up to', usd(data.qualifiedUpTo)) : '');

    var clearBtn = data.clear ? '<button class="ks-clear" id="ksClearBtn">Clear selection</button>' : '';

    el.innerHTML = '<div class="ksbar-inner">' + ctx +
      '<div class="ks-metrics">' + metrics + '</div>' +
      (clearBtn ? '<div class="ks-sep"></div>' + clearBtn : '') +
    '</div>';
    el.style.display = '';

    if (data.clear) {
      var b = el.querySelector('#ksClearBtn');
      if (b) b.addEventListener('click', data.clear);
    }
  }

  function hide(el) { if (el) el.style.display = 'none'; }

  /* Stack the bar directly beneath a sticky nav, and (optionally) push a sticky
     filter bar below it, so all three layers stack instead of overlapping. */
  function position(barEl, navSelector, belowEl) {
    if (!barEl) return;
    var nav = document.querySelector(navSelector || 'nav.nav');
    var navH = nav ? nav.getBoundingClientRect().height : 0;
    barEl.style.top = navH + 'px';
    if (belowEl) {
      var barH = barEl.getBoundingClientRect().height;
      belowEl.style.top = (navH + barH) + 'px';
    }
  }

  root.KSNumberBar = { render: render, hide: hide, position: position, MAX_BACK: MAX_BACK, PROG_LABEL: PROG_LABEL };
})(typeof window !== 'undefined' ? window : this);
