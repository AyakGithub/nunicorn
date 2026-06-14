export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `당신은 '코니'입니다. 뉴니콘 앱의 영유아·키즈 영양제 전문 AI 상담사예요.
한국인 영양소 섭취기준(KDRIs)을 기반으로 0~12세 아이의 영양제에 대해 친절하고 정확하게 안내합니다.

답변 원칙:
- 짧고 명확하게 (3~5문장 이내)
- 월령/나이별 권장량, 복용 시간, 병용 금기 위주로 답변
- 의학적 진단이나 처방은 하지 않고, 필요 시 소아과 상담 권유
- 친근한 말투 사용 (예: ~해요, ~이에요)
- 이모지 1~2개 자연스럽게 활용`;

export default async function handler(req) {
  // CORS 허용 헤더
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: corsHeaders
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: '잘못된 요청이에요.' }), {
      status: 400, headers: corsHeaders
    });
  }

  const { message, childName, childAge, supplements } = body;

  const supList = supplements && supplements.length > 0
    ? supplements.map(s => s.name || s).join(', ')
    : '없음';

  const userContext = `아이 정보: 이름 ${childName || '미설정'}, 나이 ${childAge || '미설정'}, 현재 복용 중인 영양제: ${supList}`;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'API 키가 설정되지 않았어요. Vercel 환경변수를 확인해주세요.' }), {
      status: 500, headers: corsHeaders
    });
  }

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
          { role: 'user', content: `${userContext}\n\n질문: ${message}` }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      // 실제 오류 내용을 로그 + 클라이언트에 전달
      const errMsg = data?.error?.message || JSON.stringify(data);
      console.error('Anthropic API error:', errMsg);
      return new Response(JSON.stringify({ error: `AI 오류: ${errMsg}` }), {
        status: 502, headers: corsHeaders
      });
    }

    const reply = data.content?.[0]?.text || '죄송해요, 다시 시도해주세요.';
    return new Response(JSON.stringify({ reply }), {
      status: 200, headers: corsHeaders
    });

  } catch (err) {
    console.error('Chat error:', err);
    return new Response(JSON.stringify({ error: `연결 오류: ${err.message}` }), {
      status: 500, headers: corsHeaders
    });
  }
}
