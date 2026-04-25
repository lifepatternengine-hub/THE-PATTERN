// Vercel Node.js serverless function — GET /api/confirm?t=<token>
// Verifies an HMAC-signed token from /api/subscribe, writes the subscriber to
// Notion (if configured), and returns a styled HTML success/error page.

const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed.');
  }

  if (!process.env.SUBSCRIBE_SECRET) {
    console.error('[confirm] SUBSCRIBE_SECRET not set');
    return sendPage(res, 500, errorPage('Server misconfigured', 'Token signing key is missing.'));
  }

  const token = (req.query && req.query.t ? String(req.query.t) : '').trim();
  if (!token) {
    return sendPage(res, 400, errorPage('Missing token', 'This link is incomplete. Try requesting a new confirmation email from the homepage.'));
  }

  const payload = verifyToken(token, process.env.SUBSCRIBE_SECRET);
  if (!payload) {
    return sendPage(res, 400, errorPage('Link invalid or expired', 'Confirmation links last 48 hours. Request a new one from the homepage.'));
  }

  const email = String(payload.email || '').toLowerCase();
  const source = String(payload.source || 'footer');

  // Write to Notion (optional, non-blocking on failure)
  if (process.env.NOTION_TOKEN && process.env.NOTION_NEWSLETTER_DB_ID) {
    try {
      const notionRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
          parent: { database_id: process.env.NOTION_NEWSLETTER_DB_ID },
          properties: {
            Email: { email },
            Date: { date: { start: new Date().toISOString() } },
            Source: { rich_text: [{ text: { content: source } }] },
          },
        }),
      });
      if (!notionRes.ok) {
        const err = await notionRes.json().catch(() => ({}));
        console.error('[confirm] Notion error:', err);
      } else {
        console.log('[confirm] Notion: row created for', email);
      }
    } catch (err) {
      console.error('[confirm] Notion request failed:', err);
    }
  } else {
    console.log('[confirm] Notion: skipped (env vars not set)');
  }

  return sendPage(res, 200, successPage(email));
};

// ── Token verify ───────────────────────────────────────────────────────────
function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  if (sig.length !== expected.length) return null;
  let ok = false;
  try { ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch (_) { return null; }
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || !payload.email || !payload.exp) return null;
  if (Date.now() > Number(payload.exp)) return null;
  return payload;
}

// ── Response helper ────────────────────────────────────────────────────────
function sendPage(res, status, html) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).send(html);
}

// ── HTML pages ─────────────────────────────────────────────────────────────
function pageShell(title, inner) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} — The Pattern</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;1,300;1,400&family=IBM+Plex+Mono:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#080708; --fg:#f0ebe0; --fg-dim:rgba(240,235,224,0.55);
      --fg-muted:rgba(240,235,224,0.3); --accent:oklch(0.70 0.18 318);
      --rule:rgba(240,235,224,0.1);
      --serif:'Cormorant Garamond',Georgia,serif;
      --mono:'IBM Plex Mono',monospace;
    }
    *,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
    body {
      background:var(--bg); color:var(--fg); font-family:var(--mono); font-weight:300;
      line-height:1.65; -webkit-font-smoothing:antialiased; min-height:100vh;
      display:flex; align-items:center; justify-content:center; padding:48px 24px;
    }
    .card {
      max-width:520px; width:100%; padding:48px 44px;
      border:1px solid var(--rule); border-radius:6px;
      background:rgba(240,235,224,0.02);
    }
    .ptag {
      font-size:9px; letter-spacing:0.2em; text-transform:uppercase;
      color:var(--fg-muted); margin-bottom:24px;
    }
    .icon {
      display:inline-flex; align-items:center; justify-content:center;
      width:42px; height:42px; border-radius:50%;
      border:1px solid var(--accent); color:var(--accent);
      font-size:18px; margin-bottom:22px;
    }
    h1 {
      font-family:var(--serif); font-size:38px; font-weight:300;
      line-height:1.2; letter-spacing:-0.01em; margin-bottom:18px;
    }
    h1 em { font-style:italic; color:var(--fg-dim); }
    p { font-size:13px; color:var(--fg-dim); line-height:1.85; margin-bottom:14px; }
    .email { color:var(--fg); }
    hr { border:none; border-top:1px solid var(--rule); margin:32px 0 26px; }
    .actions { display:flex; flex-direction:column; gap:14px; margin-top:8px; }
    .btn {
      display:inline-flex; align-items:center; justify-content:center;
      font-family:var(--mono); font-size:10px; font-weight:500;
      letter-spacing:0.16em; text-transform:uppercase;
      padding:15px 28px; border-radius:3px; text-decoration:none;
      transition:background 0.2s, color 0.2s, border-color 0.2s;
    }
    .btn-primary { background:var(--fg); color:var(--bg); }
    .btn-primary:hover { background:var(--accent); color:var(--fg); }
    .btn-ghost { color:var(--fg-dim); border:1px solid var(--rule); }
    .btn-ghost:hover { color:var(--fg); border-color:var(--fg-dim); }
    .meta {
      font-size:9px; letter-spacing:0.14em; text-transform:uppercase;
      color:var(--fg-muted); margin-top:30px;
    }
    .meta a { color:inherit; text-decoration:none; border-bottom:1px solid var(--rule); }
    .meta a:hover { color:var(--fg-dim); }
  </style>
</head>
<body>
  <div class="card">${inner}</div>
</body>
</html>`;
}

function successPage(email) {
  return pageShell('Subscription confirmed', `
    <div class="ptag">The Pattern · Weekly</div>
    <div class="icon">✓</div>
    <h1>You're in. <em>Confirmed.</em></h1>
    <p>Welcome to The Pattern. We'll send <span class="email">${escapeHtml(email)}</span> one article a week — one archetype, the full picture. Nothing else.</p>
    <hr>
    <div class="actions">
      <a class="btn btn-primary" href="https://life-pattern-engine.xyz">Take the diagnostic →</a>
      <a class="btn btn-ghost" href="https://the-pattern.xyz">Back to the homepage</a>
    </div>
    <div class="meta">© 2026 · the-pattern.xyz</div>
  `);
}

function errorPage(title, message) {
  return pageShell(title, `
    <div class="ptag">The Pattern · Confirmation</div>
    <h1>${escapeHtml(title)}.</h1>
    <p>${escapeHtml(message)}</p>
    <hr>
    <div class="actions">
      <a class="btn btn-primary" href="https://the-pattern.xyz#digest">Try signing up again →</a>
    </div>
    <div class="meta">© 2026 · the-pattern.xyz</div>
  `);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
