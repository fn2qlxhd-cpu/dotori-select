// /api/analyze.js
// Vercel Serverless Function — Gemini API 키를 서버 환경변수에만 보관하고,
// 프론트엔드 요청을 대신 받아서 Gemini를 호출한 뒤 결과만 돌려준다.
// 키는 절대 클라이언트(브라우저)로 노출되지 않는다.

export default async function handler(req, res) {
  // CORS 허용 (필요시 도메인을 좁혀도 됨)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: '서버에 GEMINI_API_KEY가 설정되지 않았어요. Vercel 환경변수를 확인해주세요.' });
  }

  const { systemPrompt, userMessage } = req.body || {};
  if (!systemPrompt || !userMessage) {
    return res.status(400).json({ error: 'systemPrompt와 userMessage가 필요합니다' });
  }
  // 비정상적으로 큰 요청 차단 (정상 사용 시 제품 5개 기준 약 15000자 내외면 충분)
  if (userMessage.length > 25000) {
    return res.status(400).json({ error: '입력 내용이 너무 많아요. 링크 수를 줄이거나 직접 입력 내용을 줄여주세요.' });
  }

  // 제품 비교 결과 구조를 강제하는 responseSchema
  const responseSchema = {
    type: 'object',
    properties: {
      verdict: { type: 'string' },
      winner_id: { type: 'integer' },
      products: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            price: { type: 'string' },
            scores: {
              type: 'object',
              properties: {
                가격: { type: 'number' },
                성능: { type: 'number' },
                내구성: { type: 'number' },
                후기: { type: 'number' },
                가성비: { type: 'number' },
                디자인: { type: 'number' },
                'A/S': { type: 'number' }
              }
            },
            total: { type: 'number' },
            pros: { type: 'array', items: { type: 'string' } },
            cons: { type: 'array', items: { type: 'string' } },
            strengths_vs_others: { type: 'array', items: { type: 'string' } },
            rank_reason: { type: 'string' },
            loser_reason: { type: 'string', nullable: true }
          },
          required: ['id', 'name', 'scores', 'total', 'pros', 'cons']
        }
      },
      winner_reason: { type: 'string' },
      checklist: { type: 'array', items: { type: 'string' } }
    },
    required: ['verdict', 'winner_id', 'products', 'winner_reason', 'checklist']
  };

  // gemini-2.5-flash: 안정적이고 비용 효율적인 stable 모델 (2026년 6월 기준)
  // 필요시 'gemini-3.5-flash'(더 강력하지만 비용 약 6배) 등으로 교체 가능
  const model = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{ role: 'user', parts: [{ text: userMessage }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      maxOutputTokens: 4096,
      temperature: 0.4
    }
  };

  try {
    const data = await callGemini(url, payload);

    const finishReason = data.candidates?.[0]?.finishReason;
    if (finishReason === 'MAX_TOKENS') {
      return res.status(200).json({
        error: '응답이 너무 길어 중간에 끊겼어요. 링크 수를 줄여서 다시 시도해주세요.',
        partial: true
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'AI 응답이 비어있어요. 다시 시도해주세요.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: 'AI 응답을 해석하지 못했어요. 다시 시도해주세요.' });
    }

    return res.status(200).json(parsed);

  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: '분석이 너무 오래 걸려요. 다시 시도해주세요.' });
    }
    if (e.code === 'RATE_LIMITED') {
      return res.status(429).json({ error: '지금 이용자가 많아서 잠시 막혔어요. 10~20초 후에 다시 시도해주세요.' });
    }
    if (e.status) {
      return res.status(e.status).json({ error: e.message });
    }
    return res.status(500).json({ error: '서버 오류: ' + (e.message || '알 수 없는 오류') });
  }
}

// Gemini 호출 — 429(분당 요청 한도 초과)면 짧게 대기 후 한 번만 자동 재시도
async function callGemini(url, payload, isRetry) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  clearTimeout(timeoutId);

  if (geminiRes.status === 429 && !isRetry) {
    await new Promise(r => setTimeout(r, 3000));
    return callGemini(url, payload, true);
  }

  if (!geminiRes.ok) {
    if (geminiRes.status === 429) {
      const err = new Error('rate limited');
      err.code = 'RATE_LIMITED';
      throw err;
    }
    const errBody = await geminiRes.json().catch(() => ({}));
    const msg = errBody?.error?.message || `Gemini API 오류 (${geminiRes.status})`;
    const err = new Error(msg);
    err.status = geminiRes.status;
    throw err;
  }

  return geminiRes.json();
}
