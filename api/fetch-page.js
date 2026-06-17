// /api/fetch-page.js
// Jina Reader 호출을 서버에서 대리 수행 — 브라우저 CORS 이슈를 피하고 일관된 에러 처리를 제공한다.
// Jina Reader는 키가 필요 없는 무료 서비스이므로 보안상 민감하지 않지만,
// 서버를 한 번 거치면 타임아웃/에러 패턴 감지를 일관되게 적용할 수 있다.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다' });

  const { url } = req.body || {};
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ error: '유효한 URL이 필요합니다' });
  }

  try {
    const result = await fetchFromJina(url);
    return res.status(200).json(result);
  } catch (e) {
    return res.status(200).json({ ok: false, reason: 'network_error' });
  }
}

async function fetchFromJina(url, isRetry) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 11000);

    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'X-Return-Format': 'markdown', 'X-Timeout': '10', 'X-No-Cache': 'true' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    // 429(요청 과다)는 1.5초 대기 후 한 번만 재시도
    if (jinaRes.status === 429 && !isRetry) {
      await new Promise(r => setTimeout(r, 1500));
      return fetchFromJina(url, true);
    }

    if (!jinaRes.ok) {
      return { ok: false, reason: `status_${jinaRes.status}` };
    }

    const text = await jinaRes.text();
    if (!text || text.length < 30) {
      return { ok: false, reason: 'empty' };
    }

    // 에러/로딩 페이지 캡처 감지
    const errorPatterns = [/에러페이지/, /시스템\s*오류/, /system\s*error/i, /page\s*not\s*found/i,
      /접근.{0,5}거부/, /access\s*denied/i, /잠시\s*후\s*다시\s*시도/, /unauthorized/i,
      /429|too many requests/i];
    const looksLikeError = errorPatterns.some(p => p.test(text.slice(0, 500))) && text.length < 800;
    if (looksLikeError) {
      if (!isRetry) {
        await new Promise(r => setTimeout(r, 1500));
        return fetchFromJina(url, true);
      }
      return { ok: false, reason: 'error_page' };
    }

    const tm = text.match(/^Title:\s*(.+)/m) || text.match(/^#\s+(.+)/m);
    const title = tm ? tm[1].trim().slice(0, 80) : '';

    return { ok: true, title, content: text.slice(0, 3500) };

  } catch (e) {
    if (e.name === 'AbortError') {
      return { ok: false, reason: 'timeout' };
    }
    throw e;
  }
}
