import express from 'express';

export function createApp(status) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', (_req, res) => {
    const ready = status.whatsapp && status.database && !status.stopping;
    res.status(ready ? 200 : 503).json({ ready: Boolean(ready) });
  });
  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return app;
}
