// Build step: query the Notion Articles DB and render articles.html from
// articles.template.html by replacing the <!--CARDS--> marker.
//
// Env:
//   NOTION_TOKEN            — Notion integration secret
//   NOTION_ARTICLES_DB_ID   — Articles database ID (with or without dashes)
//
// Without those vars set, the template is copied through with zero cards
// (empty-state shows). Lets local previews + first-deploy succeed.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PATTERN_TO_PHASE = { Friction: '1', Dissolution: '2', Reconstruction: '3' };

// Pool of cover images sourced from https://unsplash.com/s/photos/nebula
// (free, non-Plus). Used as fallback when an article has no Cover set in
// Notion; one is picked deterministically per slug so the same article
// always renders with the same image.
const NEBULA_COVERS = [
  '1462332420958-a05d1e002413',
  '1608178398319-48f814d0750c',
  '1504333638930-c8787321eee0',
  '1610296669228-602fa827fc1f',
  '1716881139357-ddcb2f52940c',
  '1594683734152-0eccf2501041',
  '1706800696671-570820e7ff39',
  '1502134249126-9f3755a50d78',
  '1462331940025-496dfbfc7564',
  '1717705422478-0b42e89e06b7',
  '1606125784258-570fc63c22c1',
  '1677357623576-7c8aab08da22',
  '1570556319136-3cfc640168a4',
  '1684019608073-e79bc1642ec5',
  '1684018864429-42c0966d71e0',
];

const hashString = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

const pickNebulaCover = (key) => {
  const id = NEBULA_COVERS[hashString(key || '') % NEBULA_COVERS.length];
  return `https://images.unsplash.com/photo-${id}?w=1200&q=80&fit=crop`;
};

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = escapeHtml;

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
};

const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r.plain_text || '').join('') : '');

async function fetchPublishedArticles() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_ARTICLES_DB_ID;
  if (!token || !dbId) {
    console.warn('[build-articles] NOTION_TOKEN or NOTION_ARTICLES_DB_ID missing — rendering 0 articles.');
    return [];
  }

  const out = [];
  let cursor;
  do {
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify({
        filter: { property: 'Status', select: { equals: 'Posted' } },
        sorts: [{ property: 'Published', direction: 'descending' }],
        start_cursor: cursor,
        page_size: 100,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Notion query failed: ${res.status} ${body}`);
    }
    const data = await res.json();
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return out.map((page) => {
    const props = page.properties || {};
    const title = plain(props['Title']?.title);
    const slug =
      plain(props['Slug']?.rich_text)?.trim() || slugify(title);
    const pattern = props['Pattern']?.select?.name || '';
    const excerpt = plain(props['Excerpt']?.rich_text);
    const cover = props['Cover']?.url || '';
    const readTime = props['Read time']?.number || null;
    const publishDate = props['Published']?.date?.start || null;
    return { id: page.id, title, slug, pattern, excerpt, cover, readTime, publishDate };
  });
}

function renderCard(article) {
  const phase = PATTERN_TO_PHASE[article.pattern] || '1';
  const dateText = formatDate(article.publishDate);
  const timeText = article.readTime ? `${article.readTime} min` : '';
  const meta = [dateText, timeText].filter(Boolean).join(' · ');
  const href = article.slug ? `/articles/${escapeAttr(article.slug)}` : '#';
  const cover = article.cover || pickNebulaCover(article.slug || article.id || article.title);

  return `      <a href="${href}" class="acard" data-phase="${phase}">
        <div class="acard-img">
          <img src="${escapeAttr(cover)}" alt="" loading="lazy">
        </div>
        <div class="acard-phase">PATTERN · ${escapeHtml(article.pattern || '')}</div>
        <h3 class="acard-title">${escapeHtml(article.title)}</h3>
        <p class="acard-excerpt">${escapeHtml(article.excerpt)}</p>
        <div class="acard-meta">
          <span class="acard-read">Read <span class="ar">→</span></span>
          <span class="acard-time">${escapeHtml(meta)}</span>
        </div>
      </a>`;
}

async function main() {
  const templatePath = join(ROOT, 'articles.template.html');
  const outPath = join(ROOT, 'articles.html');
  const dataPath = join(ROOT, '_articles.json');

  const template = await readFile(templatePath, 'utf8');
  let articles = [];
  try {
    articles = await fetchPublishedArticles();
  } catch (err) {
    console.warn('[build-articles] Notion fetch failed — shipping empty state:', err.message);
  }
  const cardsHtml = articles.map(renderCard).join('\n');
  const html = template.replace('<!--CARDS-->', cardsHtml);

  await writeFile(outPath, html, 'utf8');
  await writeFile(dataPath, JSON.stringify(articles, null, 2), 'utf8');
  console.log(`[build-articles] Rendered ${articles.length} article(s) → articles.html`);
}

main().catch((err) => {
  console.error('[build-articles] failed:', err);
  process.exit(1);
});
