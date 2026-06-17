// /api/fetch-page.js
// 제품 페이지 읽기 API
// 1) 네이버쇼핑/스마트스토어/단축 URL은 직접 HTML 메타데이터를 먼저 읽고
// 2) 실패하면 Jina Reader로 본문을 읽는다.
// 네이버쇼핑처럼 JS 렌더링/차단이 많은 페이지도 최소한 상품명/설명/URL 기반 분석이 가능하게 만든다.

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function isNaverLike(url) {
  return /(^|\/\/|\.)naver\.(com|me)|smartstore\.naver\.com|shopping\.naver\.com/i.test(url);
}

function cleanText(s = '') {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickMeta(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`, 'i');
    const m = html.match(re1) || html.match(re2);
    if (m?.[1]) return cleanText(m[1]);
  }
  return '';
}

function extractFromHtml(html, url) {
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  const ogTitle = pickMeta(html, ['og:title', 'twitter:title']);
  const desc = pickMeta(html, ['og:description', 'description', 'twitter:description']);
  const price = pickMeta(html, ['product:price:amount', 'og:price:amount']);

  let title = cleanText(ogTitle || titleTag)
    .replace(/\s*[:|>-]?\s*NAVER\s*$/i, '')
    .replace(/\s*[:|>-]?\s*네이버\s*쇼핑\s*$/i, '')
    .slice(0, 90);

  // 네이버/쇼핑 페이지에서 title이 비어 있으면 URL 마지막 경로로 최소 제목 생성
  if (!title) {
    try {
      const u = new URL(url);
      title = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '네이버쇼핑 상품').slice(0, 90);
    } catch { title = '상품'; }
  }

  const body = cleanText(html).slice(0, 1600);
  const parts = [
    `상품명: ${title}`,
    desc ? `설명: ${desc}` : '',
    price ? `가격: ${price}` : '',
    body ? `페이지 텍스트: ${body}` : '',
    `원본 URL: ${url}`
  ].filter(Boolean);

  return { title, content: parts.join('\n').slice(0, 2300) };
}

async function fetchWithTimeout(url, options = {}, ms = 9000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchDirect(url) {
  const directRes = await fetchWithTimeout(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  }, 9000);

  if (!directRes.ok) throw new Error(`direct_${directRes.status}`);
  const html = await directRes.text();
  if (!html || html.length < 80) throw new Error('direct_empty');

  const extracted = extractFromHtml(html, directRes.url || url);
  if (!extracted.title && extracted.content.length < 80) throw new Error('direct_no_content');
  return extracted;
}

async function fetchJina(url) {
  const encoded = encodeURI(url);
  const jinaRes = await fetchWithTimeout(`https://r.jina.ai/${encoded}`, {
    headers: { 'X-Return-Format': 'markdown', 'X-Timeout': '10', 'X-No-Cache': 'true' }
  }, 11000);

  if (!jinaRes.ok) throw new Error(`status_${jinaRes.status}`);

  const text = await jinaRes.text();
  if (!text || text.length < 30) throw new Error('empty');

  const errorPatterns = [/에러페이지/, /시스템\s*오류/, /system\s*error/i, /page\s*not\s*found/i,
    /접근.{0,5}거부/, /access\s*denied/i, /잠시\s*후\s*다시\s*시도/, /unauthorized/i];
  const looksLikeError = errorPatterns.some(p => p.test(text.slice(0, 500))) && text.length < 800;
  if (looksLikeError) throw new Error('error_page');

  const tm = text.match(/^Title:\s*(.+)/m) || text.match(/^#\s+(.+)/m);
  const title = tm ? tm[1].trim().slice(0, 90) : '';
  return { title, content: text.slice(0, 2300) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다' });

  const { url } = req.body || {};
  if (!isHttpUrl(url)) {
    return res.status(400).json({ error: '유효한 URL이 필요합니다' });
  }

  const targetUrl = String(url).trim();

  try {
    // 네이버 계열은 Jina보다 직접 메타 읽기가 더 안정적인 경우가 많다.
    if (isNaverLike(targetUrl)) {
      try {
        const direct = await fetchDirect(targetUrl);
        return res.status(200).json({ ok: true, title: direct.title, content: direct.content, source: 'direct_meta' });
      } catch (_) {
        // direct 실패 시 아래 Jina로 진행
      }
    }

    try {
      const jina = await fetchJina(targetUrl);
      return res.status(200).json({ ok: true, title: jina.title, content: jina.content, source: 'jina' });
    } catch (jinaErr) {
      // 일반 페이지도 Jina 실패 시 직접 메타 읽기 한 번 더 시도
      try {
        const direct = await fetchDirect(targetUrl);
        return res.status(200).json({ ok: true, title: direct.title, content: direct.content, source: 'direct_meta_fallback' });
      } catch (_) {
        return res.status(200).json({ ok: false, reason: jinaErr.message || 'fetch_failed' });
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return res.status(200).json({ ok: false, reason: 'timeout' });
    return res.status(200).json({ ok: false, reason: 'network_error' });
  }
}
