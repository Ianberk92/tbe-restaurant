'use strict';
/**
 * Browser-side settings that shouldn't live in the repo.
 *
 *   GET /api/config   → { mapsEmbedKey }   (any signed-in user)
 *
 * mapsEmbedKey is a Google Maps Embed API key from the SWA app setting
 * GOOGLE_MAPS_EMBED_KEY. It is a browser key (it ends up in the map iframe's
 * URL anyway), so it must be restricted in Google Cloud to the site's
 * domains and to the Maps Embed API only. Empty when not configured; the
 * front end then falls back to Google's keyless embed.
 */
const { app } = require('@azure/functions');
const { getPrincipal } = require('../lib/auth');

const KEY_RE = /^[A-Za-z0-9_-]{20,80}$/;

async function handler(request) {
  if (!getPrincipal(request)) return { status: 401, jsonBody: { error: 'Sign in required' } };
  const key = (process.env.GOOGLE_MAPS_EMBED_KEY || '').trim();
  return {
    status: 200,
    jsonBody: { mapsEmbedKey: KEY_RE.test(key) ? key : '' },
    headers: { 'Cache-Control': 'no-store' },
  };
}

app.http('config', {
  methods: ['GET'],
  authLevel: 'anonymous', // auth is enforced by Static Web Apps + the check above
  route: 'config',
  handler,
});

module.exports = { handler }; // exported for local tests
