export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `당신은 '코니'입니다. 뉴니콘 앱의 영유아·키즈 영양제 전문 AI 상담사예요.
한국인 영양소 섭취기준(KDRIs)을 기반으로 0~12세 아이의 영양제에 대해 친절하고 정확하게 안내합니다.

답변 원칙:
- 짧고 명확하게 (3~5문장 이내)
- 월령/나이별 권장량, 복용 시간, 주의사항 위주로 답변
- 의학적 진단이나 처방은 하지 않고, 필요 시 소아과/소아청소년과 상담 권유
- 친근한 말투 사용 (예: ~해요, ~이에요)
- 이모지 1~2개 자연스럽게 활용
- 근거가 불명확한 경우 단정하지 않고 "전문가 확인을 권해요"로 표현
- 의학적 진단, 질병 치료, 개별 처방처럼 표현하지 않기`;

const USER_FRIENDLY_ERROR = '지금은 상담 연결이 원활하지 않아요. 잠시 후 다시 시도해 주세요.';

// ── 위험 키워드 분류 ─────────────────────────────────────────────
// high: 즉각 검토 필요 (안전 관련)
const RISK_KEYWORDS_HIGH = [
  '과다복용', '과용량', '중독', '응급', '구토', '경련', '의식', '쓰러졌',
  '호흡', '입술이 파래', '알레르기 쇼크', '아나필락시', '실신',
  '너무 많이 먹', '한꺼번에 먹', '실수로 먹', '잘못 먹',
];
// caution: 주의 확인 필요
const RISK_KEYWORDS_CAUTION = [
  '상한량', '최대용량', '용량 초과', '너무 많은', '여러 개 동시',
  '약이랑 같이', '처방약', '항생제', '스테로이드', '소아과 안 가고',
  '진단', '치료', '처방',
];

function classifyRisk(text) {
  const lower = text.toLowerCase();
  const highMatch = RISK_KEYWORDS_HIGH.filter(k => lower.includes(k));
  if (highMatch.length > 0) return { level: 'high', flags: highMatch };
  const cautionMatch = RISK_KEYWORDS_CAUTION.filter(k => lower.includes(k));
  if (cautionMatch.length > 0) return { level: 'caution', flags: cautionMatch };
  return { level: 'normal', flags: [] };
}

// ── Supabase 로깅 (service role key 필요) ────────────────────────
async function logChat({
  userId, userAgent, question, answer,
  status, errorCode, riskLevel, riskFlags,
  childAgeLabel, childMonths, disclaimerShown, quotaDeducted,
  supplements,
}) {
  const supaUrl = process.env.SUPA_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceKey) return; // 환경변수 없으면 조용히 스킵

  try {
    const payload = {
      user_id: userId || null,
      question,
      answer: answer || null,
      status,
      error_code: errorCode || null,
      risk_level: riskLevel || 'normal',
      risk_flags: riskFlags?.length ? riskFlags : null,
      child_age_label: childAgeLabel || null,
      child_months: childMonths || null,
      disclaimer_shown: disclaimerShown ?? true,
      quota_deducted: quotaDeducted ?? false,
      supplements_context: supplements || null,
      user_agent: userAgent?.slice(0, 200) || null,
    };

    await fetch(`${supaUrl}/rest/v1/chat_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[nunicorn] chat log failed:', e.message);
  }
}

export default async function handler(req) {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://www.nunicorn.co.kr',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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

  const { message, childAge, childMonths, supplements, userId, disclaimerShown } = body;

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
    console.error('[nunicorn] ANTHROPIC_API_KEY not configured');
    return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
      status: 503, headers: corsHeaders
    });
  }

  const supList = Array.isArray(supplements) && supplements.length > 0
    ? supplements.map(s => (s.name || String(s))).slice(0, 10).join(', ')
    : '없음';

  const userContext = `아이 나이: ${childAge || '미설정'}, 현재 복용 중인 영양제: ${supList}`;
  const userAgent = req.headers.get('User-Agent') || '';

  // 위험 키워드 사전 분류
  const questionRisk = classifyRisk(message);

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
      const errCode = errData?.error?.type || `http_${response.status}`;
      console.error('[nunicorn] Anthropic API error', response.status, errCode);

      // 실패 로깅 (쿼터 차감 없음)
      logChat({
        userId, userAgent, question: message.trim(), answer: null,
        status: 'failed', errorCode: errCode,
        riskLevel: questionRisk.level, riskFlags: questionRisk.flags,
        childAgeLabel: childAge, childMonths, disclaimerShown,
        quotaDeducted: false, supplements: supList,
      });

      return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
        status: 502, headers: corsHeaders
      });
    }

    const data = await response.json();
    const reply = data.content?.[0]?.text;

    if (!reply) {
      console.error('[nunicorn] Empty reply from API');

      logChat({
        userId, userAgent, question: message.trim(), answer: null,
        status: 'empty_reply', errorCode: 'no_content',
        riskLevel: questionRisk.level, riskFlags: questionRisk.flags,
        childAgeLabel: childAge, childMonths, disclaimerShown,
        quotaDeducted: false, supplements: supList,
      });

      return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
        status: 502, headers: corsHeaders
      });
    }

    // 답변 내용에서도 위험 키워드 재분류 (AI가 이상한 내용 포함 시 감지)
    const answerRisk = classifyRisk(reply);
    const finalRiskLevel = questionRisk.level === 'high' || answerRisk.level === 'high'
      ? 'high'
      : questionRisk.level === 'caution' || answerRisk.level === 'caution'
        ? 'caution'
        : 'normal';
    const finalRiskFlags = [...new Set([...questionRisk.flags, ...answerRisk.flags])];

    // 성공 로깅 (쿼터 차감됨)
    logChat({
      userId, userAgent, question: message.trim(), answer: reply,
      status: 'success', errorCode: null,
      riskLevel: finalRiskLevel, riskFlags: finalRiskFlags,
      childAgeLabel: childAge, childMonths, disclaimerShown,
      quotaDeducted: true, supplements: supList,
    });

    return new Response(JSON.stringify({ reply }), {
      status: 200, headers: corsHeaders
    });

  } catch (chatErr) {
    clearTimeout(timeoutId);

    if (chatErr.name === 'AbortError') {
      console.error('[nunicorn] API timeout');

      logChat({
        userId, userAgent, question: message.trim(), answer: null,
        status: 'timeout', errorCode: 'timeout',
        riskLevel: questionRisk.level, riskFlags: questionRisk.flags,
        childAgeLabel: childAge, childMonths, disclaimerShown,
        quotaDeducted: false, supplements: supList,
      });

      return new Response(JSON.stringify({ error: '응답 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.' }), {
        status: 504, headers: corsHeaders
      });
    }

    console.error('[nunicorn] Chat error:', chatErr.name);

    logChat({
      userId, userAgent, question: message.trim(), answer: null,
      status: 'failed', errorCode: chatErr.name,
      riskLevel: questionRisk.level, riskFlags: questionRisk.flags,
      childAgeLabel: childAge, childMonths, disclaimerShown,
      quotaDeducted: false, supplements: supList,
    });

    return new Response(JSON.stringify({ error: USER_FRIENDLY_ERROR }), {
      status: 500, headers: corsHeaders
    });
  }
}
