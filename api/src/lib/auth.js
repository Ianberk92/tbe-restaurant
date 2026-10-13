'use strict';
/**
 * Reads the identity Azure Static Web Apps injects into every API request.
 * SWA strips any client-supplied x-ms-client-principal header, so this value
 * can be trusted when the API is the SWA "managed" API (or a linked backend).
 */
function getPrincipal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function hasRole(principal, role) {
  return !!principal && Array.isArray(principal.userRoles) && principal.userRoles.includes(role);
}

/** Display name for audit fields: the sign-in name (usually the work email). */
function who(principal) {
  return (principal && principal.userDetails) || 'unknown';
}

module.exports = { getPrincipal, hasRole, who };
