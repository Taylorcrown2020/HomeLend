/* nav.js — shared, auth-aware navigation.
   The SERVER SESSION is the single source of truth for "logged in." On every
   page this asks /api/me once and shows/hides nav items accordingly:
     • elements marked  data-auth="in"   show only when logged in
     • elements marked  data-auth="out"  show only when logged out
     • an element marked data-nav-user   gets the signed-in email
     • a button marked   data-logout      logs out and returns home
   Logged-in-only items should also start hidden (inline style="display:none")
   so a logged-out visitor never even briefly sees "Find a Home". */
(function () {
  'use strict';

  function applyAuth(authed, user) {
    document.querySelectorAll('[data-auth="in"]').forEach(function (el) {
      el.style.display = authed ? '' : 'none';
    });
    document.querySelectorAll('[data-auth="out"]').forEach(function (el) {
      el.style.display = authed ? 'none' : '';
    });
    document.querySelectorAll('[data-nav-user]').forEach(function (el) {
      el.textContent = (authed && user && user.email) ? user.email : '';
    });
    // let pages react if they want to
    try {
      window.dispatchEvent(new CustomEvent('ks-auth', { detail: { authed: authed, user: user || null } }));
    } catch (e) {}
  }

  function logout(e) {
    if (e && e.preventDefault) e.preventDefault();
    fetch('/api/logout', { method: 'POST', credentials: 'same-origin' })
      .then(function () { window.location.href = '/'; })
      .catch(function () { window.location.href = '/'; });
  }

  function init() {
    document.querySelectorAll('[data-logout]').forEach(function (b) {
      b.addEventListener('click', logout);
    });
    fetch('/api/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { applyAuth(!!(j && j.user), j && j.user); })
      .catch(function () { applyAuth(false, null); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.KSNav = { logout: logout, applyAuth: applyAuth };
})();
