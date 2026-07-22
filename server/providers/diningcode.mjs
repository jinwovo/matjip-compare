// 다이닝코드 맛집 검색 (비공식 isearch 엔드포인트)
// 검색 응답에 별점(user_score, 5점 만점)/평가수(review_cnt)/좌표가 함께 담겨 오므로
// 카카오처럼 상세 호출이 필요 없다. 토큰 없이 동작.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function searchDiningcode(query, lat, lng, { signal } = {}) {
  const params = {
    query,
    order: 'r_score', // 다이닝코드 랭킹 순
    page: '1',
    size: '20',
    search_type: 'poi_search',
    rn_search_flag: 'on',
  };
  // 좌표가 있으면 위치 편향 (동명 가게 정확도 ↑)
  if (isFinite(lat) && isFinite(lng)) {
    params.lat = String(lat);
    params.lng = String(lng);
  }

  const res = await fetch('https://im.diningcode.com/API/isearch/', {
    method: 'POST',
    signal,
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://www.diningcode.com/',
      Origin: 'https://www.diningcode.com',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) throw new Error(`diningcode search ${res.status}`);
  const json = await res.json();
  const list = json?.result_data?.poi_section?.list;
  if (!Array.isArray(list)) return [];

  return list
    .map((p) => {
      const plat = Number(p.lat);
      const plng = Number(p.lng);
      if (!isFinite(plat) || !isFinite(plng)) return null;
      const userScore = Number(p.user_score); // 5점 만점 사용자 별점
      const reviews = Number(p.review_cnt); // 별점을 매긴 사람 수
      const rid = String(p.v_rid ?? '');
      return {
        platform: 'diningcode',
        id: rid,
        // 매칭 정확도를 위해 지점명까지 포함 (예: "농민백암순대 본점")
        name: [p.nm, p.branch].filter(Boolean).join(' ').trim() || p.nm || '',
        category: p.category || '',
        address: p.road_addr || p.addr || '',
        lat: plat,
        lng: plng,
        score: userScore > 0 ? userScore : null, // 별점 (5점 만점) — 타 플랫폼과 직접 비교
        scoreCount: reviews > 0 ? reviews : null, // 별점 모수
        reviewCount: reviews > 0 ? reviews : null,
        dcScore: Number(p.score) || null, // 다이닝코드 자체 점수(100점 척도) — 참고용
        url: rid ? `https://www.diningcode.com/profile.php?rid=${rid}` : null,
      };
    })
    .filter(Boolean);
}
