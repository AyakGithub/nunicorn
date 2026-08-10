export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `당신은 '코니'입니다. 뉴니콘 앱의 영유아·키즈 영양제 전문 AI 상담사예요.
한국인 영양소 섭취기준(KDRIs)을 기반으로 0~12세 아이의 영양제에 대해 친절하고 정확하게 안내합니다.

답변 원칙:
- 짧고 명확하게 (3~5문장 이내)
- 월령/나이별 권장량, 복용 시간, 병용 금기 위주로 답변
- 의학적 진단이나 처방은 하지 않고, 필요 시 소아과/소아청소년과 상담 권유
- 친근한 말투 사용 (예: ~해요, ~이에요)
- 이모지 1~2개 자연스럽게 활용
- 근거가 불명확한 경우 단정하지 않고 "전문가 확인을 권해요"로 표현
- 의학적 진단, 질병 치료, 개별 처방처럼 표현하지 않기`;

const USER_FRIENDLY_ERROR = '지금은 상담 연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.';

export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.nunicorn.co.kr',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: '잘못된 요청이에요.' }), {
      status: 405, headers: corsHeaders
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: '잘못된 요청 형식이에요.' }), {
      status: 400, headers: corsHeaders
    });
  }

  const { message, childAge, supplements } = body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return new Response(JSON.stringify({ error: '질문 내용이 비어 있어요.' }), {
      status: 400, headers: corsHeaders
    });
  }

  // 메시지 길이 제한 (과도한 입력 방지)
  if (message.length > 500) {
    return new Response(JSON.stringify({ error: '질문이 너무 길어요. 500자 이내로 입력해 주세요.' }), {
      status: 400, headers: corsHeaders
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 내부 오류 상세 내용은 서버 로그에만 기록
    console.error('[nunicorn] ANTHROPIC_API_KEY not configured');
    return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
      status: 503, headers: corsHeaders
    });
  }

  const supList = Array.isArray(supplements) && supplements.length > 0
    ? supplements.map(s => (s.name || String(s))).slice(0, 10).join(', ')
    : '없음';

  const userContext = `아이 나이: ${childAge || '미설정'}, 현재 복용 중인 영양제: ${supList}`;

  // 30초 timeout 적용
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `${userContext}\n\n질문: ${message.trim()}` }
        ]
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      // 내부 오류 코드 및 메시지는 서버 로그에만 기록
      console.error('[nunicorn] Anthropic API error', response.status, errData?.error?.type);
      return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
        status: 502, headers: corsHeaders
      });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text;

    if (!reply) {
      console.error('[nunicorn] Empty reply from API');
      return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
        status: 502, headers: corsHeaders
      });
    }

    return new Response(JSON.stringify({ reply }), {
      status: 200, headers: corsHeaders
    });

  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      console.error('[nunicorn] API timeout');
      return new Response(JSON.stringify({ error: '응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.' }), {
        status: 504, headers: corsHeaders
      });
    }
    // 네트워크 오류 등은 상세 내용 없이 로그만
    console.error('[nunicorn] Chat error:', err.name);
    return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
      status: 500, headers: corsHeaders
    });
  }
}
