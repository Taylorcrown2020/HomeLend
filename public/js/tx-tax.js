/* =============================================================================
 * tx-tax.js — Texas property-tax estimator
 * -----------------------------------------------------------------------------
 * Texas property tax is NOT levied by ZIP. It's the sum of overlapping taxing
 * units: county + city + school district (ISD) + special districts (MUD/PID/ESD).
 * A MUD alone can add 0.5–1.5%. So a ZIP gives you a COUNTY, and a county gives
 * a reasonable *effective* average — not a parcel-exact rate.
 *
 * This module ships:
 *   • COUNTY_RATES  — effective avg rate (% of market value) for TX counties.
 *                     Populous counties are tuned; rural counties fall back to
 *                     the regional/statewide default. CONFIGURE with your data.
 *   • ZIP_COUNTY    — a representative ZIP→county map for the major metros.
 *                     In production load the full HUD ZIP-COUNTY crosswalk
 *                     (loadCrosswalk) so every TX ZIP resolves to a county.
 *   • estimate(zip) — returns {county, ratePct, source} with source flagged so
 *                     the UI can tell the user when it's a county estimate vs a
 *                     statewide fallback they should override.
 *
 * Effective rates here are realistic ballparks; verify against the county
 * appraisal district + the specific parcel's MUD/PID for an exact figure.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TxTax = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATEWIDE_DEFAULT = 1.80; // % — TX effective avg is among the highest in the US

  // Effective average property-tax rate (% of market value) by county.
  // Suburban MUD-heavy counties (Fort Bend, Williamson, Denton) skew high.
  const COUNTY_RATES = {
    'Harris': 2.05, 'Dallas': 1.99, 'Tarrant': 2.10, 'Bexar': 2.04, 'Travis': 1.80,
    'Collin': 1.83, 'Denton': 1.90, 'Fort Bend': 2.20, 'Williamson': 1.97, 'Montgomery': 1.90,
    'El Paso': 2.45, 'Hidalgo': 1.92, 'Galveston': 1.85, 'Brazoria': 2.00, 'Nueces': 1.95,
    'Bell': 1.78, 'Lubbock': 1.78, 'Webb': 2.00, 'McLennan': 1.85, 'Cameron': 1.90,
    'Hays': 1.92, 'Comal': 1.70, 'Guadalupe': 1.85, 'Kaufman': 1.95, 'Ellis': 1.80,
    'Johnson': 1.75, 'Parker': 1.55, 'Rockwall': 1.95, 'Smith': 1.55, 'Gregg': 1.55,
    'Potter': 1.95, 'Randall': 1.70, 'Midland': 1.55, 'Ector': 1.75, 'Taylor': 1.85,
    'Wichita': 1.85, 'Grayson': 1.65, 'Wise': 1.60, 'Hood': 1.45, 'Burnet': 1.55,
    'San Patricio': 1.85, 'Victoria': 1.70, 'Brazos': 1.85, 'Jefferson': 1.95, 'Orange': 1.85,
    'Liberty': 1.70, 'Chambers': 1.65, 'Waller': 1.85, 'Bastrop': 1.85, 'Caldwell': 1.80,
    'Walker': 1.65, 'Tom Green': 1.75, 'Angelina': 1.45, 'Henderson': 1.40, 'Anderson': 1.45,
  };

  // Representative ZIP → county. Production: replace with full HUD crosswalk via loadCrosswalk().
  // Keyed by exact ZIP where known; prefix ranges handled in estimate().
  const ZIP_COUNTY = {
    // Houston / Harris & neighbors
    '77002':'Harris','77003':'Harris','77004':'Harris','77005':'Harris','77024':'Harris',
    '77019':'Harris','77077':'Harris','77449':'Harris','77459':'Fort Bend','77478':'Fort Bend',
    '77479':'Fort Bend','77494':'Fort Bend','77845':'Brazos','77380':'Montgomery','77381':'Montgomery',
    '77584':'Brazoria','77573':'Galveston','77550':'Galveston',
    // Dallas–Fort Worth
    '75201':'Dallas','75204':'Dallas','75205':'Dallas','75230':'Dallas','75080':'Dallas',
    '75024':'Collin','75025':'Collin','75070':'Collin','75035':'Collin','75002':'Collin',
    '75056':'Denton','75057':'Denton','76201':'Denton','76210':'Denton','75065':'Denton',
    '76102':'Tarrant','76104':'Tarrant','76244':'Tarrant','76001':'Tarrant','76051':'Tarrant',
    '75032':'Rockwall','75087':'Rockwall','75088':'Rockwall',
    '75126':'Kaufman','75142':'Kaufman','75119':'Ellis','75104':'Dallas','75165':'Ellis',
    // Austin
    '78701':'Travis','78704':'Travis','78745':'Travis','78759':'Travis','78660':'Travis',
    '78664':'Williamson','78681':'Williamson','78626':'Williamson','78628':'Williamson',
    '78610':'Hays','78640':'Hays','78666':'Hays',
    // San Antonio
    '78201':'Bexar','78209':'Bexar','78217':'Bexar','78258':'Bexar','78130':'Comal',
    '78132':'Comal','78155':'Guadalupe','78130':'Comal',
    // El Paso / West
    '79901':'El Paso','79912':'El Paso','79936':'El Paso','79924':'El Paso',
    '79701':'Midland','79705':'Midland','79762':'Ector','79761':'Ector',
    '79401':'Lubbock','79410':'Lubbock','79424':'Lubbock','79101':'Potter','79124':'Randall',
    // South Texas / Coast
    '78501':'Hidalgo','78539':'Hidalgo','78550':'Cameron','78521':'Cameron','78040':'Webb',
    '78401':'Nueces','78411':'Nueces','78415':'Nueces',
    // Central / East
    '76701':'McLennan','76710':'McLennan','76801':'Brown','76904':'Tom Green','75701':'Smith',
    '75703':'Smith','75605':'Gregg','77701':'Jefferson','77640':'Jefferson',
  };

  // ZIP first-3 → likely county (coarse fallback when exact ZIP unknown).
  const PREFIX_COUNTY = {
    '770':'Harris','772':'Harris','773':'Montgomery','774':'Fort Bend','775':'Galveston',
    '752':'Dallas','750':'Collin','751':'Dallas','761':'Tarrant','762':'Denton',
    '787':'Travis','786':'Williamson','782':'Bexar','781':'Bexar',
    '799':'El Paso','885':'El Paso','797':'Midland','794':'Lubbock','791':'Potter',
    '785':'Hidalgo','784':'Nueces','780':'Webb','767':'McLennan','757':'Smith','776':'Jefferson',
  };

  let crosswalk = null; // optional full map injected at runtime

  /** Inject a complete ZIP→county map (e.g. parsed HUD crosswalk). */
  function loadCrosswalk(map) { crosswalk = map || null; }

  function countyRate(county) {
    if (county && COUNTY_RATES[county] != null) return COUNTY_RATES[county];
    return STATEWIDE_DEFAULT;
  }

  /**
   * estimate(zip) → { county, ratePct, source }
   * source: 'county' (zip matched a county) | 'prefix' (coarse) | 'statewide' (fallback)
   */
  function estimate(zip) {
    const z = String(zip || '').trim().slice(0, 5);
    if (!/^\d{5}$/.test(z) || z[0] !== '7' && !z.startsWith('885')) {
      // Not a plausible TX ZIP
      if (!/^\d{5}$/.test(z)) return { county: null, ratePct: STATEWIDE_DEFAULT, source: 'statewide' };
    }
    let county = (crosswalk && crosswalk[z]) || ZIP_COUNTY[z];
    if (county) return { county, ratePct: countyRate(county), source: 'county' };

    const pfx = PREFIX_COUNTY[z.slice(0, 3)];
    if (pfx) return { county: pfx, ratePct: countyRate(pfx), source: 'prefix' };

    return { county: null, ratePct: STATEWIDE_DEFAULT, source: 'statewide' };
  }

  function annualTax(zip, price) {
    const e = estimate(zip);
    return { county: e.county, ratePct: e.ratePct, source: e.source,
             annual: Math.round((+price || 0) * e.ratePct / 100),
             monthly: Math.round((+price || 0) * e.ratePct / 100 / 12) };
  }

  return { estimate, annualTax, countyRate, loadCrosswalk,
           COUNTY_RATES, ZIP_COUNTY, STATEWIDE_DEFAULT };
}));
