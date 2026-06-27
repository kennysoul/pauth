import { Hono } from 'hono';
import type { AuthContext, Env } from '../types';
import { csrfOriginCheck } from './lib/csrf';
import { systemRoutes } from './routes/system';
import { setupRoutes } from './routes/setup';
import { registerRoutes } from './routes/register';
import { loginRoutes } from './routes/login';
import { meRoutes } from './routes/me';
import { adminRoutes } from './routes/admin';
import { requireAuth } from './middleware/auth';

const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();

app.use('/api/*', csrfOriginCheck);

app.route('/api/system', systemRoutes);
app.route('/api', systemRoutes);        // expose /api/verify (no auth)
app.route('/api/setup', setupRoutes);
app.route('/api/register', registerRoutes);
app.route('/api/login', loginRoutes);
app.route('/api', meRoutes);

app.use('/api/admin/*', requireAuth);
app.route('/api/admin', adminRoutes);

app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
