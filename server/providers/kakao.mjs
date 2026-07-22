// Kakao 지도 검색 (비공식 mapsearch 엔드포인트)
// 검색 결과에 별점/별점수/리뷰수가 함께 담겨 오므로 상세 호출이 필요 없다.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// kakao mapsearch 원시 JSON (검색·지오코딩 공용). 응답은 UTF-8.
async function kakaoRaw(query, signal) {
  const url = `https://search.map.kakao.com/mapsearch/map.daum?q=${encodeURIComponent(
    query,
  )}&msFlag=A&sort=0`;
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': UA, Referer: 'https://map.kakao.com/' },
  });
  if (!res.ok) throw new Error(`kakao search ${res.status}`);
  return JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
}

// 지역명 → 좌표(지오코딩). 공식 행정구역(address)이 있으면 그 중심+반경을, 없으면
// 대표 장소(place[0])로 폴백(예: "홍대"→홍익대). 지역명 검색을 지도 이동에 쓴다.
export async function geocodeKakao(q, { placeFallback = true, signal } = {}) {
  const json = await kakaoRaw(q, signal);
  // 1) 공식 행정구역 우선 — 정확한 지역 중심 + 검색반경(시=20km, 동=1km 등)
  const a = Array.isArray(json.address) ? json.address[0] : null;
  if (a && isFinite(Number(a.lat)) && isFinite(Number(a.lon))) {
    return {
      found: true,
      type: 'region',
      lat: Number(a.lat),
      lng: Number(a.lon),
      label: a.addr || q,
      radius: Number(json.search_center_radius) || 3000,
    };
  }
  // 2) 콜로퀴얼/특정 장소 폴백 (홍대, 강남역 등)
  if (placeFallback) {
    const p = Array.isArray(json.place) ? json.place[0] : null;
    if (p && isFinite(Number(p.lat)) && isFinite(Number(p.lon))) {
      return { found: true, type: 'place', lat: Number(p.lat), lng: Number(p.lon), label: p.name || q, radius: 2000 };
    }
  }
  return { found: false };
}

export async function searchKakao(query, { signal } = {}) {
  const json = await kakaoRaw(query, signal);
  const places = Array.isArray(json.place) ? json.place : [];

  return places
    .map((p) => {
      const lat = Number(p.lat);
      const lng = Number(p.lon);
      if (!isFinite(lat) || !isFinite(lng)) return null;
      const ratingCount = num(p.rating_count);
      const rating = num(p.rating_average);
      return {
        platform: 'kakao',
        id: String(p.confirmid ?? p.id ?? ''),
        name: p.name ?? '',
        category: p.last_cate_name || p.cate_name_depth2 || '',
        address: cleanAddr(p.new_address_disp || p.address_disp || p.address || ''),
        lat,
        lng,
        // 별점(5점 만점), 별점을 매긴 사람 수, 텍스트 리뷰 수
        score: rating > 0 ? rating : null,
        scoreCount: ratingCount > 0 ? ratingCount : null,
        reviewCount: num(p.reviewCount) || null,
        url: p.confirmid ? `https://place.map.kakao.com/${p.confirmid}` : null,
      };
    })
    .filter(Boolean);
}

// 카카오 주소 표기는 '|'로 구분되어 옴 → 공백으로 정리
function cleanAddr(s) {
  return String(s).replace(/\|+/g, ' ').replace(/\s+/g, ' ').trim();
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}
