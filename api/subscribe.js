// Vercel Node.js serverless function — POST /api/subscribe
// Validates email, saves to Notion (optional), sends confirmation email via Resend (optional).
// Required env vars (set in Vercel project settings):
//   RESEND_API_KEY        — for sending the confirmation email
//   RESEND_FROM           — verified sender, e.g. "The Pattern <hello@the-pattern.xyz>"
//   NOTION_TOKEN          — Notion integration token (optional)
//   NOTION_NEWSLETTER_DB_ID — Notion database id with Email/Date/Source props (optional)

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const email = (body && body.email ? String(body.email) : '').trim();
  const source = body && body.source ? String(body.source) : 'footer';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const debug = {
    has_resend_key: !!process.env.RESEND_API_KEY,
    has_resend_from: !!process.env.RESEND_FROM,
    resend_from: process.env.RESEND_FROM || '(not set, using default)',
    has_notion_token: !!process.env.NOTION_TOKEN,
    has_notion_db: !!process.env.NOTION_NEWSLETTER_DB_ID,
  };
  console.log('[subscribe] env check:', debug);

  try {
    // 1. Save to Notion (optional, non-blocking on failure)
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
          console.error('[subscribe] Notion error:', err);
        } else {
          console.log('[subscribe] Notion: row created');
        }
      } catch (err) {
        console.error('[subscribe] Notion request failed:', err);
      }
    } else {
      console.log('[subscribe] Notion: skipped (env vars not set)');
    }

    // 2. Send confirmation email via Resend HTTP API
    if (!process.env.RESEND_API_KEY) {
      console.error('[subscribe] Resend: SKIPPED — RESEND_API_KEY not set in this deployment env');
      return res.status(500).json({
        error: 'Email service not configured.',
        debug,
      });
    }

    const fromAddr = process.env.RESEND_FROM || 'The Pattern <hello@the-pattern.xyz>';
    console.log('[subscribe] Resend: sending from', fromAddr, 'to', email);

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [email],
        subject: "You're in — The Pattern",
        html: confirmationEmail(email),
      }),
    });

    const resendBody = await resendRes.json().catch(() => ({}));
    if (!resendRes.ok) {
      console.error('[subscribe] Resend error:', resendRes.status, resendBody);
      return res.status(502).json({
        error: 'Email send failed.',
        resend_status: resendRes.status,
        resend_body: resendBody,
      });
    }

    console.log('[subscribe] Resend: sent', resendBody);
    return res.status(200).json({ success: true, id: resendBody.id });
  } catch (err) {
    console.error('[subscribe] Unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.', detail: String(err && err.message || err) });
  }
};

function confirmationEmail(email) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>You're in — The Pattern</title>
</head>
<body style="margin:0;padding:0;background:#080708;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#080708;padding:48px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;">
          <tr>
            <td style="background:#13111a;border-radius:14px 14px 0 0;padding:30px 40px;text-align:center;">
              <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#f0ebe0;letter-spacing:-0.3px;">
                The <em style="font-style:italic;color:#a885d4;">Pattern</em>
              </span>
            </td>
          </tr>
          <tr>
            <td style="background:#0f0d14;border:1px solid rgba(240,235,224,0.12);border-top:none;border-radius:0 0 14px 14px;padding:40px 40px 36px;">
              <h1 style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:30px;color:#f0ebe0;line-height:1.25;font-weight:400;">
                You're in. <em style="font-style:italic;color:rgba(240,235,224,0.55);">Confirmed.</em>
              </h1>
              <p style="margin:0 0 18px;font-size:15px;color:rgba(240,235,224,0.7);line-height:1.75;">
                Welcome to The Pattern — a diagnostic feed for creative professionals navigating identity transition in midlife.
              </p>
              <p style="margin:0 0 32px;font-size:15px;color:rgba(240,235,224,0.7);line-height:1.75;">
                One article. One archetype. Every week. No noise.
              </p>
              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border-radius:3px;background:#a885d4;">
                    <a href="https://life-pattern-engine.xyz"
                       style="display:inline-block;padding:14px 28px;font-family:'Courier New',monospace;font-size:11px;font-weight:500;color:#080708;text-decoration:none;border-radius:3px;letter-spacing:0.14em;text-transform:uppercase;">
                      Take the diagnostic →
                    </a>
                  </td>
                </tr>
              </table>
              <hr style="margin:36px 0 22px;border:none;border-top:1px solid rgba(240,235,224,0.1);">
              <p style="margin:0;font-size:11px;color:rgba(240,235,224,0.4);line-height:1.7;">
                You subscribed with <strong style="color:rgba(240,235,224,0.7);">${escapeHtml(email)}</strong>.
                If this wasn't you, ignore this email — you won't hear from us again.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 40px;text-align:center;">
              <p style="margin:0;font-size:10px;color:rgba(240,235,224,0.35);letter-spacing:0.1em;text-transform:uppercase;line-height:1.8;">
                © 2026 · the-pattern.xyz
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
