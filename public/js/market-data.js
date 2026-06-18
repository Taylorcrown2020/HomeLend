/* =============================================================================
 * market-data.js — Seeded rate sheet + property listings data layer
 * -----------------------------------------------------------------------------
 * RATES: a realistic rate/points grid per program. These are SEED values, not a
 * live quote. Wire fetchLiveRates() to your pricing engine (Optimal Blue,
 * Polly, etc.) to replace them daily. Rates shown to a borrower must come from
 * a real lock desk before any disclosure.
 *
 * LISTINGS: sample inventory so the dashboard works end-to-end. There is NO
 * legal public API for Zillow/Redfin/Realtor. Replace fetchListings() with a
 * licensed feed: a RESO Web API / IDX feed from your MLS, or a paid aggregator
 * (ATTOM, RentCast, Bridge Interactive). The function signature is the contract.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MarketData = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // base 30yr rate per program; each step of points buys ~0.25% down.
  const BASE_30 = {
    conventional: 6.75, conventional_fthb: 6.875, fha: 6.50, va: 6.375,
    usda: 6.50, jumbo: 6.99, land: 8.50,
  };

  /** Build a small rate/points grid the borrower picks from. */
  function rateGrid(program, term, creditScore) {
    const base = (BASE_30[program] || 6.75) + (term === 15 ? -0.5 : 0)
      + (creditScore && creditScore < 680 ? 0.375 : 0)
      + (creditScore && creditScore < 640 ? 0.375 : 0);
    const rows = [];
    // points: negative = lender credit, positive = buying down
    [{ pts: -1.0, adj: +0.375 }, { pts: -0.5, adj: +0.20 }, { pts: 0, adj: 0 },
     { pts: 0.5, adj: -0.18 }, { pts: 1.0, adj: -0.35 }, { pts: 2.0, adj: -0.65 }]
      .forEach(o => {
        const rate = Math.round((base + o.adj) * 1000) / 1000;
        rows.push({ rate, points: o.pts, apr: Math.round((rate + 0.12) * 1000) / 1000 });
      });
    return { program, term, asOf: new Date().toISOString().slice(0, 10), rows, disclaimer:
      'Seed pricing for estimation only — not a rate lock or quote.' };
  }

  // --- Sample listing inventory (swap for a licensed MLS/IDX feed) -----------
  const PHOTO = (seed) => `https://picsum.photos/seed/${seed}/640/420`;
  const SAMPLE = [
    { id:'tx-1001', title:'Highland Retreat', address:'2345 Highland Ave', city:'Dallas', zip:'75205',
      price:399000, beds:2, baths:1, sqft:1180, type:'single_family', lot:0.18, year:1948, rating:5.0, hoa:0,
      lat:32.835, lng:-96.79, photos:[PHOTO('hl1'),PHOTO('hl2'),PHOTO('hl3')] },
    { id:'tx-1002', title:'Beverly Breeze', address:'3456 Beverly Dr', city:'Fort Worth', zip:'76104',
      price:449000, beds:3, baths:2, sqft:1860, type:'single_family', lot:0.22, year:2004, rating:4.8, hoa:35,
      lat:32.71, lng:-97.32, photos:[PHOTO('bb1'),PHOTO('bb2'),PHOTO('bb3')] },
    { id:'tx-1003', title:'Laurel Canyon Nest', address:'5678 Laurel Canyon Blvd', city:'Austin', zip:'78745',
      price:475000, beds:2, baths:1, sqft:1320, type:'single_family', lot:0.20, year:1962, rating:4.5, hoa:0,
      lat:30.21, lng:-97.79, photos:[PHOTO('lc1'),PHOTO('lc2')] },
    { id:'tx-1004', title:'Sugar Mill Cottage', address:'910 Sweetwater Ln', city:'Sugar Land', zip:'77479',
      price:520000, beds:4, baths:3, sqft:2640, type:'single_family', lot:0.25, year:2012, rating:4.7, hoa:95,
      lat:29.59, lng:-95.62, photos:[PHOTO('sm1'),PHOTO('sm2'),PHOTO('sm3')] },
    { id:'tx-1005', title:'Bishop Arts Bungalow', address:'410 Davis St', city:'Dallas', zip:'75208',
      price:365000, beds:2, baths:2, sqft:1100, type:'single_family', lot:0.12, year:1939, rating:5.0, hoa:0,
      lat:32.75, lng:-96.83, photos:[PHOTO('ba1'),PHOTO('ba2')] },
    { id:'tx-1006', title:'Mueller Modern', address:'1900 Aldrich St #210', city:'Austin', zip:'78723',
      price:415000, beds:2, baths:2, sqft:1240, type:'condo', lot:0, year:2018, rating:4.6, hoa:310,
      lat:30.30, lng:-97.70, photos:[PHOTO('mm1'),PHOTO('mm2')] },
    { id:'tx-1007', title:'Hill Country Acreage', address:'TBD Ranch Rd 12', city:'Wimberley', zip:'78676',
      price:189000, beds:0, baths:0, sqft:0, type:'land', lot:5.2, year:0, rating:4.4, hoa:0,
      lat:29.99, lng:-98.10, photos:[PHOTO('ld1'),PHOTO('ld2')] },
    { id:'tx-1008', title:'Galveston Bay Duplex', address:'77 Seawall Blvd', city:'Galveston', zip:'77550',
      price:540000, beds:4, baths:4, sqft:2400, type:'multi_family', lot:0.10, year:1995, rating:4.3, hoa:0,
      lat:29.27, lng:-94.80, photos:[PHOTO('gb1'),PHOTO('gb2')] },
    { id:'tx-1009', title:'Lakeside at Rockwall', address:'120 Harbor View', city:'Rockwall', zip:'75032',
      price:610000, beds:4, baths:3, sqft:3010, type:'single_family', lot:0.30, year:2015, rating:4.9, hoa:120,
      lat:32.86, lng:-96.43, photos:[PHOTO('rw1'),PHOTO('rw2'),PHOTO('rw3')] },
    { id:'tx-1010', title:'Alamo Heights Charmer', address:'215 Patterson Ave', city:'San Antonio', zip:'78209',
      price:485000, beds:3, baths:2, sqft:1720, type:'single_family', lot:0.19, year:1955, rating:4.7, hoa:0,
      lat:29.48, lng:-98.46, photos:[PHOTO('ah1'),PHOTO('ah2')] },
    { id:'tx-1011', title:'West El Paso Newbuild', address:'6500 Desert Sky', city:'El Paso', zip:'79912',
      price:325000, beds:3, baths:2, sqft:1900, type:'single_family', lot:0.16, year:2021, rating:4.5, hoa:40,
      lat:31.85, lng:-106.56, photos:[PHOTO('ep1'),PHOTO('ep2')] },
    { id:'tx-1012', title:'Preston Hollow Estate', address:'5050 Walnut Hill Ln', city:'Dallas', zip:'75229',
      price:1450000, beds:5, baths:5, sqft:5200, type:'single_family', lot:0.55, year:2009, rating:4.9, hoa:0,
      lat:32.89, lng:-96.83, photos:[PHOTO('ph1'),PHOTO('ph2'),PHOTO('ph3')] },
  ];

  /**
   * fetchListings(filters) — returns matching listings.
   * filters: { minPrice, maxPrice, beds, minSqft, types:[], zip }
   * PRODUCTION: replace body with a call to your licensed MLS/IDX/aggregator.
   */
  function fetchListings(filters) {
    const f = filters || {};
    return SAMPLE.filter(p => {
      if (f.maxPrice != null && p.price > f.maxPrice) return false;
      if (f.minPrice != null && p.price < f.minPrice) return false;
      if (f.beds != null && f.beds > 0 && p.beds < f.beds) return false;
      if (f.minSqft != null && f.minSqft > 0 && p.sqft < f.minSqft) return false;
      if (f.types && f.types.length && !f.types.includes(p.type)) return false;
      if (f.zip && String(p.zip) !== String(f.zip)) return false;
      return true;
    });
  }

  function fetchLiveRates() { /* hook: call pricing engine; falls back to seed */ return null; }

  return { rateGrid, fetchListings, fetchLiveRates, BASE_30, _sample: SAMPLE };
}));
