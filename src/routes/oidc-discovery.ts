import { Hono } from 'hono';
import type { Env } from '../types';
import { getPublicJwks } from '../lib/oidc-keys';

export const oidcDiscoveryRoutes = new Hono<{ Bindings: Env }>();

oidcDiscoveryRoutes.get('/openid-configuration', async (c) => {
  const origin = c.env.ORIGIN;
  return c.json({
    issuer: origin,
    authorization_endpoint: `${origin}/api/l2/authorize`,
    token_endpoint: `${origin}/api/l2/token`,
    userinfo_endpoint: `${origin}/api/l2/userinfo`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    claims_supported: ['sub', 'email', 'name'],
  });
});

oidcDiscoveryRoutes.get('/jwks.json', async (c) => {
  const jwks = await getPublicJwks(c.env);
  return c.json(jwks);
});
