// Vercel Cron handler — POSTs to a Vercel deploy hook to trigger a fresh
// build, which re-runs scripts/build-articles.mjs and picks up any new
// Status=Published rows in the Notion Articles DB.
//
// Configured by vercel.json crons[0] to run Tuesdays 08:00 UTC.
//
// Env:
//   VERCEL_DEPLOY_HOOK_URL  — the Deploy Hook URL from Vercel project settings
//   CRON_SECRET             — optional shared secret; if set, requests must
//                             include `Authorization: Bearer <CRON_SECRET>`
//                             (Vercel Cron does this automatically when
//                             CRON_SECRET is defined as an env var).

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const hook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hook) {
    console.error('[rebuild] VERCEL_DEPLOY_HOOK_URL not set');
    return res.status(500).json({ error: 'Deploy hook not configured' });
  }

  try {
    const r = await fetch(hook, { method: 'POST' });
    const body = await r.text().catch(() => '');
    if (!r.ok) {
      console.error('[rebuild] deploy hook returned', r.status, body);
      return res.status(502).json({ error: 'Deploy hook failed', status: r.status });
    }
    console.log('[rebuild] deploy triggered:', body.slice(0, 200));
    return res.status(200).json({ ok: true, triggeredAt: new Date().toISOString() });
  } catch (err) {
    console.error('[rebuild] request failed:', err);
    return res.status(500).json({ error: 'Request failed' });
  }
};
