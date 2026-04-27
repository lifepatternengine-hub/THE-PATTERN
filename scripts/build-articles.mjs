// Build step: query the Notion Articles DB and render the articles index
// (articles.html) plus one page per article (articles/<slug>.html) using
// the corresponding template files.
//
// Env:
//   NOTION_TOKEN            — Notion integration secret
//   NOTION_ARTICLES_DB_ID   — Articles database ID (with or without dashes)
//
// Without those vars set (or if Notion is unreachable), we ship the index
// page with an empty state and skip rendering individual article pages —
// so first-deploy and local previews succeed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PATTERN_TO_PHASE = { Friction: '1', Dissolution: '2', Reconstruction: '3' };

// Pool of cover images sourced from https://unsplash.com/s/photos/nebula
// (free, non-Plus). Used as fallback when an article has no Cover set in
// Notion. Articles are assigned a cover in stable order so no two
// articles share an image (up to NEBULA_COVERS.length articles).
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

const coverUrl = (id, w = 1200) =>
  `https://images.unsplash.com/photo-${id}?w=${w}&q=80&fit=crop`;

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
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
};

const plain = (rich) => (Array.isArray(rich) ? rich.map((r) => r.plain_text || '').join('') : '');

async function notionFetch(path, token, init = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Notion ${path} failed: ${res.status} ${body}`);
  }
  return res.json();
}

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
    const data = await notionFetch(`/databases/${dbId}/query`, token, {
      method: 'POST',
      body: JSON.stringify({
        filter: { property: 'Status', select: { equals: 'Posted' } },
        sorts: [{ property: 'Published', direction: 'descending' }],
        start_cursor: cursor,
        page_size: 100,
      }),
    });
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  const articles = out.map((page) => {
    const props = page.properties || {};
    const title = plain(props['Title']?.title);
    const slug = plain(props['Slug']?.rich_text)?.trim() || slugify(title);
    const pattern = props['Pattern']?.select?.name || '';
    const excerpt = plain(props['Excerpt']?.rich_text);
    const cover = props['Cover']?.url || '';
    const readTime = props['Read time']?.number || null;
    const publishDate = props['Published']?.date?.start || null;
    return { id: page.id, title, slug, pattern, excerpt, cover, readTime, publishDate };
  });

  // Fetch full body content for each article in parallel.
  await Promise.all(
    articles.map(async (a) => {
      try {
        a.blocks = await fetchBlocks(a.id, token);
      } catch (err) {
        console.warn(`[build-articles] failed to fetch blocks for "${a.title}":`, err.message);
        a.blocks = [];
      }
    }),
  );

  return articles;
}

async function fetchBlocks(blockId, token) {
  const out = [];
  let cursor;
  do {
    const data = await notionFetch(
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`,
      token,
    );
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ── Notion blocks → HTML ──────────────────────────────────────────────

function renderRichText(rich) {
  if (!Array.isArray(rich)) return '';
  return rich
    .map((r) => {
      let html = escapeHtml(r.plain_text || '');
      const ann = r.annotations || {};
      if (ann.code) html = `<code>${html}</code>`;
      if (ann.bold) html = `<strong>${html}</strong>`;
      if (ann.italic) html = `<em>${html}</em>`;
      if (ann.underline) html = `<span style="text-decoration:underline">${html}</span>`;
      if (ann.strikethrough) html = `<s>${html}</s>`;
      if (r.href) html = `<a href="${escapeAttr(r.href)}" rel="noopener">${html}</a>`;
      return html;
    })
    .join('');
}

function blocksToHtml(blocks) {
  const out = [];
  let listType = null; // 'ul' | 'ol' | null
  let listBuf = [];

  const flushList = () => {
    if (!listType) return;
    out.push(`<${listType}>${listBuf.join('')}</${listType}>`);
    listType = null;
    listBuf = [];
  };

  for (const b of blocks) {
    const t = b.type;
    const data = b[t] || {};
    const rich = data.rich_text || [];
    const text = renderRichText(rich);

    if (t === 'bulleted_list_item') {
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listBuf.push(`<li>${text}</li>`);
      continue;
    }
    if (t === 'numbered_list_item') {
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listBuf.push(`<li>${text}</li>`);
      continue;
    }
    flushList();

    if (t === 'paragraph') {
      out.push(text ? `<p>${text}</p>` : '');
    } else if (t === 'heading_1') {
      out.push(`<h2>${text}</h2>`);
    } else if (t === 'heading_2') {
      out.push(`<h2>${text}</h2>`);
    } else if (t === 'heading_3') {
      out.push(`<h3>${text}</h3>`);
    } else if (t === 'quote') {
      out.push(`<blockquote><p>${text}</p></blockquote>`);
    } else if (t === 'divider') {
      out.push(`<hr>`);
    } else if (t === 'callout') {
      out.push(`<blockquote><p>${text}</p></blockquote>`);
    } else if (t === 'code') {
      out.push(`<pre><code>${escapeHtml(plain(rich))}</code></pre>`);
    }
    // Other block types are silently ignored.
  }
  flushList();
  return out.filter(Boolean).join('\n');
}

// ── Cover assignment (no repeats within a build) ─────────────────────

function assignCovers(articles) {
  // Stable order: by Notion page id (creation-time-ordered). Articles
  // with an explicit Cover URL keep theirs; the rest get assigned in
  // index order so the same set of articles always picks the same
  // covers, and no two articles share one until we exceed the pool.
  const sorted = [...articles].sort((a, b) => a.id.localeCompare(b.id));
  let i = 0;
  for (const a of sorted) {
    if (a.cover) continue;
    const id = NEBULA_COVERS[i % NEBULA_COVERS.length];
    a.coverThumb = coverUrl(id, 1200);
    a.coverHero = coverUrl(id, 1920);
    i += 1;
  }
  for (const a of articles) {
    if (a.cover) {
      a.coverThumb = a.cover;
      a.coverHero = a.cover;
    }
  }
}

// ── Index page card ──────────────────────────────────────────────────

function renderCard(article) {
  const phase = PATTERN_TO_PHASE[article.pattern] || '1';
  const dateText = formatDate(article.publishDate);
  const timeText = article.readTime ? `${article.readTime} min` : '';
  const meta = [dateText, timeText].filter(Boolean).join(' · ');
  const href = article.slug ? `/articles/${escapeAttr(article.slug)}` : '#';
  const cover = article.coverThumb;

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

// ── Single article page ──────────────────────────────────────────────

function renderArticlePage(template, article) {
  const dateText = formatDate(article.publishDate);
  const timeText = article.readTime ? `${article.readTime} min read` : '';
  const meta = [dateText, timeText]
    .filter(Boolean)
    .map((s) => `<span>${escapeHtml(s)}</span>`)
    .join('<span class="ah-meta-sep"></span>');

  const body = blocksToHtml(article.blocks || []);

  return template
    .replace(/<!--ARTICLE_TITLE-->/g, escapeHtml(article.title))
    .replace(/<!--ARTICLE_PATTERN-->/g, escapeHtml(article.pattern || ''))
    .replace(/<!--ARTICLE_DESC-->/g, escapeAttr(article.excerpt || ''))
    .replace(/<!--ARTICLE_SLUG-->/g, escapeAttr(article.slug || ''))
    .replace(/<!--ARTICLE_COVER-->/g, escapeAttr(article.coverHero))
    .replace('<!--ARTICLE_META-->', meta)
    .replace('<!--ARTICLE_BODY-->', body);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const articlesIndexTemplatePath = join(ROOT, 'articles.template.html');
  const articleTemplatePath = join(ROOT, 'article.template.html');
  const homeTemplatePath = join(ROOT, 'index.template.html');
  const articlesIndexOutPath = join(ROOT, 'articles.html');
  const homeOutPath = join(ROOT, 'index.html');
  const dataPath = join(ROOT, '_articles.json');
  const articlesDir = join(ROOT, 'articles');

  const [articlesIndexTemplate, articleTemplate, homeTemplate] = await Promise.all([
    readFile(articlesIndexTemplatePath, 'utf8'),
    readFile(articleTemplatePath, 'utf8'),
    readFile(homeTemplatePath, 'utf8'),
  ]);

  let articles = [];
  try {
    articles = await fetchPublishedArticles();
  } catch (err) {
    console.warn('[build-articles] Notion fetch failed — shipping empty state:', err.message);
  }

  assignCovers(articles);

  // Articles index page (all)
  const cardsHtml = articles.map(renderCard).join('\n');
  await writeFile(
    articlesIndexOutPath,
    articlesIndexTemplate.replace('<!--CARDS-->', cardsHtml),
    'utf8',
  );

  // Homepage (latest 3 — articles arrive sorted by Published desc)
  const home3 = articles.slice(0, 3);
  const homeCardsHtml = home3.length > 0
    ? home3.map(renderCard).join('\n')
    : '      <div class="acard-empty">More soon — check back next Tuesday.</div>';
  await writeFile(homeOutPath, homeTemplate.replace('<!--HOME_CARDS-->', homeCardsHtml), 'utf8');

  // Per-article pages
  if (articles.length > 0) {
    await mkdir(articlesDir, { recursive: true });
    await Promise.all(
      articles.map(async (a) => {
        if (!a.slug) return;
        const html = renderArticlePage(articleTemplate, a);
        await writeFile(join(articlesDir, `${a.slug}.html`), html, 'utf8');
      }),
    );
  }

  await writeFile(
    dataPath,
    JSON.stringify(
      articles.map(({ blocks, ...rest }) => rest),
      null,
      2,
    ),
    'utf8',
  );
  console.log(
    `[build-articles] Rendered ${articles.length} article(s) → articles.html + articles/<slug>.html, ${home3.length} on home`,
  );
}

main().catch((err) => {
  console.error('[build-articles] failed:', err);
  process.exit(1);
});
