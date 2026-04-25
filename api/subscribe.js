// Vercel Node.js serverless function — POST /api/subscribe
// Double opt-in: signs a stateless token, emails a confirmation link.
// Notion write happens at /api/confirm only after the user clicks.
//
// Required env vars (set in Vercel project settings):
//   RESEND_API_KEY        — Resend HTTP API key (sender)
//   SUBSCRIBE_SECRET      — random string (32+ chars) used to sign confirm tokens
// Optional env vars:
//   RESEND_FROM           — verified sender, e.g. "The Pattern <hello@the-pattern.xyz>"
//   PUBLIC_BASE_URL       — origin for the confirm link, e.g. "https://the-pattern.xyz"
//                           (auto-derived from request host when unset)

const crypto = require('crypto');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 48; // 48 hours

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const email = (body && body.email ? String(body.email) : '').trim().toLowerCase();
  const source = body && body.source ? String(body.source) : 'footer';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('[subscribe] RESEND_API_KEY not set');
    return res.status(500).json({ error: 'Email service not configured.' });
  }
  if (!process.env.SUBSCRIBE_SECRET) {
    console.error('[subscribe] SUBSCRIBE_SECRET not set');
    return res.status(500).json({ error: 'Confirm token signing not configured.' });
  }

  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    `https://${req.headers['x-forwarded-host'] || req.headers.host || 'the-pattern.xyz'}`;

  const token = signToken({ email, source }, process.env.SUBSCRIBE_SECRET);
  const confirmUrl = `${baseUrl}/api/confirm?t=${encodeURIComponent(token)}`;

  try {
    const fromAddr = process.env.RESEND_FROM || 'The Pattern <hello@the-pattern.xyz>';
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [email],
        subject: 'Confirm your subscription — The Pattern',
        html: confirmEmail(email, confirmUrl),
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

    console.log('[subscribe] Confirm email sent to', email, 'id', resendBody.id);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[subscribe] Unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// ── Token signing ──────────────────────────────────────────────────────────
function signToken(payload, secret) {
  const body = { ...payload, exp: Date.now() + TOKEN_TTL_MS };
  const data = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// ── Email template ─────────────────────────────────────────────────────────
function confirmEmail(email, confirmUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Confirm your subscription — The Pattern</title>
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
                Confirm your subscription. <em style="font-style:italic;color:rgba(240,235,224,0.55);">One click.</em>
              </h1>

              <p style="margin:0 0 28px;font-size:15px;color:rgba(240,235,224,0.7);line-height:1.75;">
                Click below to activate the weekly digest. One article, one archetype, every week. No noise, no cheerleading.
              </p>

              <table cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="border-radius:3px;background:#a885d4;">
                    <a href="${confirmUrl}"
                       style="display:inline-block;padding:16px 32px;font-family:'Courier New',monospace;font-size:11px;font-weight:500;color:#080708;text-decoration:none;border-radius:3px;letter-spacing:0.16em;text-transform:uppercase;">
                      Confirm subscription →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:18px 0 0;font-size:11px;color:rgba(240,235,224,0.4);line-height:1.7;letter-spacing:0.04em;">
                Link expires in 48 hours.
              </p>

              <hr style="margin:32px 0 24px;border:none;border-top:1px solid rgba(240,235,224,0.1);">

              <p style="margin:0 0 14px;font-size:11px;color:rgba(240,235,224,0.45);letter-spacing:0.12em;text-transform:uppercase;line-height:1.7;">
                While you're here
              </p>
              <p style="margin:0 0 8px;font-size:14px;color:rgba(240,235,224,0.7);line-height:1.7;">
                <a href="https://life-pattern-engine.xyz" style="color:#a885d4;text-decoration:none;border-bottom:1px solid rgba(168,133,212,0.4);">
                  Take the diagnostic →
                </a>
              </p>
              <p style="margin:0 0 24px;font-size:12px;color:rgba(240,235,224,0.45);line-height:1.7;">
                28 questions, ~9 minutes. Locates where you are in the pattern, right now.
              </p>

              <hr style="margin:0 0 22px;border:none;border-top:1px solid rgba(240,235,224,0.08);">

              <p style="margin:0;font-size:11px;color:rgba(240,235,224,0.4);line-height:1.7;">
                You requested this with <strong style="color:rgba(240,235,224,0.7);">${escapeHtml(email)}</strong>.
                If this wasn't you, ignore this email — without the click, no subscription is created.
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
