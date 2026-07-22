// AI 지역 브리핑 — Claude가 지도에 보이는 맛집들을 한눈에 요약한다.
// ANTHROPIC_API_KEY(또는 ANTHROPIC_AUTH_TOKEN)가 있으면 자연어 브리핑,
// 없으면 규칙 기반 요약으로 폴백해 항상 동작한다.
import Anthropic from '@anthropic-ai/sdk';

export function hasAiKey() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `너는 한국 맛집 큐레이터야. 사용자가 지도에서 보고 있는 지역의 맛집 목록(이름, 카테고리, 3사 종합 별점, 리뷰수)을 받으면 3~4문장의 한국어 브리핑을 써.
포함할 내용: (1) 이 동네에 어떤 종류의 맛집이 강세인지, (2) 평점·리뷰 기준으로 눈에 띄는 추천 1~2곳을 이름과 함께, (3) 상황별 팁 하나(예: 데이트, 혼밥, 회식).
규칙: 목록에 있는 사실만 사용하고 과장하지 마. 마크다운·이모지·불릿 없이 자연스러운 평문 문단으로. 존댓말로 써.`;

export async function aiBrief(areaName, places) {
  const client = new Anthropic(); // 자격증명은 환경변수/프로필에서 자동 해석
  const lines = places
    .slice(0, 40)
    .map((p, i) => {
      const a = p.agg || {};
      const rating = a.rating != null ? `${a.rating}★` : '별점없음';
      return `${i + 1}. ${p.name} / ${p.category || '-'} / 종합 ${rating} / 리뷰 ${a.reviews || 0}`;
    })
    .join('\n');

  // 짧은 요약이라 사고(thinking)는 생략하고 effort는 낮게 → 빠르고 저렴.
  // (더 빠르게/저렴하게 원하면 model을 'claude-haiku-4-5'로 바꾸면 됨)
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 600,
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [
      { role: 'user', content: `지역: ${areaName}\n맛집 목록:\n${lines}\n\n이 목록을 바탕으로 브리핑을 써줘.` },
    ],
  });
  return res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// 자연어 요청 → 지도 검색용 키워드로 변환 (구조화 출력)
const NL_SYSTEM = `너는 맛집 검색 도우미야. 사용자의 자연어 요청을 지도에서 검색 가능한 "구체적인 음식/업종 키워드 하나"로 바꿔줘.
규칙:
- keyword는 실제 지도 검색어로 쓸 수 있게 짧고 구체적으로 (예: "국밥", "일식", "파스타", "삼겹살", "브런치 카페").
- 지역명(강남 등)은 keyword에 넣지 마. 위치는 앱이 알아서 처리해.
- 분위기·상황("비 오는 날", "혼밥", "데이트")은 그에 맞는 음식/업종으로 해석해서 keyword에 반영.
- note는 사용자에게 보여줄 친근한 한 문장 해석.`;

export async function nlSearch(query) {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 300,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '지도 검색에 쓸 구체적 한국어 키워드(음식/업종). 지역명 제외.' },
            note: { type: 'string', description: '사용자에게 보여줄 한 문장 해석' },
          },
          required: ['keyword', 'note'],
          additionalProperties: false,
        },
      },
    },
    system: NL_SYSTEM,
    messages: [{ role: 'user', content: query }],
  });
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const parsed = JSON.parse(text);
  return { keyword: String(parsed.keyword || '').slice(0, 40), note: String(parsed.note || '') };
}

// 키가 없을 때의 폴백: 통계 기반 템플릿 요약 (별점을 지어내지 않음)
export function ruleBrief(areaName, places) {
  const area = areaName || '이 지역';
  const cats = {};
  for (const p of places) {
    const c = (p.category || '').split(/[,/·]/)[0].trim();
    if (c) cats[c] = (cats[c] || 0) + 1;
  }
  const topCats = Object.entries(cats)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const scored = places.filter((p) => p.agg && p.agg.rating != null);
  const byRating = [...scored].sort((a, b) => b.agg.rating - a.agg.rating);
  const byReviews = [...places.filter((p) => p.agg)].sort(
    (a, b) => (b.agg.reviews || 0) - (a.agg.reviews || 0),
  );
  const top = byRating[0];
  const popular = byReviews[0];

  const parts = [];
  if (topCats.length) {
    parts.push(
      `${area}에는 맛집 ${places.length}곳이 있고, ${topCats.map(([c, n]) => `${c} ${n}곳`).join(', ')} 순으로 많습니다.`,
    );
  } else {
    parts.push(`${area}에는 맛집 ${places.length}곳이 있습니다.`);
  }
  if (top) parts.push(`평점이 가장 높은 곳은 ${top.name}(종합 ${top.agg.rating}★)입니다.`);
  if (popular && popular !== top) {
    parts.push(`리뷰가 가장 많은 곳은 ${popular.name}(리뷰 ${(popular.agg.reviews || 0).toLocaleString('ko-KR')})으로 인기가 검증된 편입니다.`);
  }
  return parts.join(' ');
}
