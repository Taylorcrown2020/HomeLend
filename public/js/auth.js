/* auth.js — makes login work even when the session cookie can't be stored
   (some hosts/proxies/browser settings drop cookies). It transparently:
     • attaches a stored token as "Authorization: Bearer <token>" to /api calls
     • captures the token returned by /api/login and /api/register-and-submit
     • clears it on /api/logout
   This loads BEFORE any other script so every fetch is covered. The cookie
   session still works too; this is a belt-and-suspenders fallback. */
(function () {
  'use strict';
  var KEY = 'ks_token';
  var mem = {}; // fallback when localStorage is unavailable (e.g. Safari private mode throws)
  function get() { try { return window.localStorage.getItem(KEY) || mem[KEY] || ''; } catch (e) { return mem[KEY] || ''; } }
  function set(t) { if (!t) return; mem[KEY] = t; try { window.localStorage.setItem(KEY, t); } catch (e) {} }
  function clear() { delete mem[KEY]; try { window.localStorage.removeItem(KEY); } catch (e) {} }

  var orig = window.fetch ? window.fetch.bind(window) : null;
  if (orig) {
    window.fetch = function (input, init) {
      init = init || {};
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var isApi = url.indexOf('/api/') === 0 || url.indexOf('/api/') !== -1;
      if (isApi) {
        if (!init.credentials) init.credentials = 'include';
        var t = get();
        if (t) {
          var h = init.headers || {};
          // normalize Headers instances to a plain object merge
          if (typeof Headers !== 'undefined' && h instanceof Headers) {
            var o = {}; h.forEach(function (v, k) { o[k] = v; }); h = o;
          }
          h.Authorization = 'Bearer ' + t;
          init.headers = h;
        }
      }
      var p = orig(input, init);
      if (isApi && /\/api\/(login|register-and-submit)/.test(url)) {
        return p.then(function (res) {
          try {
            res.clone().json().then(function (j) { if (j && j.token) set(j.token); }).catch(function () {});
          } catch (e) {}
          return res;
        });
      }
      if (isApi && /\/api\/logout/.test(url)) clear();
      return p;
    };
  }
  window.KSAuth = { token: get, set: set, clear: clear };
})();
