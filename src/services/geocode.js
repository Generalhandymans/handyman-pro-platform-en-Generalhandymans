// Optional geocoding (address -> lat/lng). OFF by default: with no
// GEOCODE_API_KEY every call returns null and matching simply keeps using its
// neutral "unknown distance" score. Supported provider: Mapbox.
// NOTE: written against Mapbox's public geocoding API but NOT exercised against
// the live service in this repo's tests — verify with a real key before relying on it.
'use strict';

function enabled() { return !!process.env.GEOCODE_API_KEY; }

async function geocode(address) {
  if (!enabled() || !address) return null;
  try {
    const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
      encodeURIComponent(address) + '.json?limit=1&access_token=' + encodeURIComponent(process.env.GEOCODE_API_KEY);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const c = data && data.features && data.features[0] && data.features[0].center;
    return c ? { lng: c[0], lat: c[1] } : null;
  } catch (e) { return null; }
}

// Great-circle distance in miles; null when either point is unknown.
function miles(a, b) {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 3958.8, rad = (d) => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

module.exports = { enabled, geocode, miles };
