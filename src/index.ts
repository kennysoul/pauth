import { Hono } from 'hono';
import type { AuthContext, Env } from '../types';
import { csrfOriginCheck } from './lib/csrf';
import { systemRoutes } from './routes/system';
import { setupRoutes } from './routes/setup';
import { registerRoutes } from './routes/register';
import { loginRoutes } from './routes/login';
import { meRoutes } from './routes/me';
import { inviteRoutes } from './routes/invite';
import { l2Routes } from './routes/l2';
import { oauthRoutes } from './routes/oauth';
import { passkeyDelegateRoutes } from './routes/passkey-delegate';
import { adminRoutes } from './routes/admin';
import { requireAuth } from './middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

app.use('/api/*', csrfOriginCheck);

app.route('/api/system', systemRoutes);
app.route('/api', systemRoutes);        // expose /api/verify (no auth)
app.route('/api/setup', setupRoutes);
app.route('/api/register', registerRoutes);
app.route('/api/invite', inviteRoutes);
app.route('/api/l2', l2Routes);
app.route('/api/oauth', oauthRoutes);
app.route('/api/passkey-delegate', passkeyDelegateRoutes);
app.route('/api/login', loginRoutes);
app.route('/api', meRoutes);

app.use('/api/admin/*', requireAuth);
app.route('/api/admin', adminRoutes);

app.all('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status !== 404 || c.req.path.startsWith('/api')) {
    return res;
  }
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url), c.req.raw));
});

export default app;
