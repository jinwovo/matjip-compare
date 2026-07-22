// 서로 다른 플랫폼의 "같은 가게"를 판별한다.
// 플랫폼마다 상호 표기·ID가 달라서, (상호 유사도 + 좌표 거리)로 동일 가게를 매칭한다.

// 상호 정규화: 공백/괄호/특수문자 제거, 소문자화. 지점명(역점/점/본점)은 남겨두되 유사도가 흡수.
export function normalizeName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()[\]{}<>·・.,'"`~!@#$%^&*_\-+=/\\|:;?]/g, '');
}

// 두 좌표 사이 거리(m) — Haversine
export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 문자열 유사도: 문자 bigram Dice 계수 (한글에 잘 맞음). 0~1.
export function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const bg = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) || 0) + 1);
    }
    return set;
  };
  const ma = bg(na);
  const mb = bg(nb);
  let inter = 0;
  for (const [g, c] of ma) if (mb.has(g)) inter += Math.min(c, mb.get(g));
  const total = na.length - 1 + (nb.length - 1);
  return total > 0 ? (2 * inter) / total : 0;
}

// 매칭 판정: 이름이 매우 비슷하면 거리를 넉넉히, 애매하면 가까워야 인정.
function isMatch(sim, dist) {
  if (sim >= 0.85 && dist <= 200) return true;
  if (sim >= 0.6 && dist <= 100) return true;
  if (sim >= 0.45 && dist <= 40) return true;
  return false;
}

// Kakao 목록을 뼈대로, 각 항목에 가장 잘 맞는 Naver 후보를 붙인다.
// 반환: 통합 레스토랑 배열. (Naver 별점/리뷰수는 나중에 클릭 시 id로 조회)
export function mergeKakaoNaver(kakaoList, naverList) {
  const usedNaver = new Set();

  const merged = kakaoList.map((k) => {
    let best = null;
    let bestScore = -1;
    naverList.forEach((n, idx) => {
      if (usedNaver.has(idx)) return;
      const sim = nameSimilarity(k.name, n.name);
      const dist = distanceMeters(k, n);
      if (!isMatch(sim, dist)) return;
      // 유사도 우선, 거리로 보정한 점수
      const score = sim - dist / 5000;
      if (score > bestScore) {
        bestScore = score;
        best = { idx, n, sim, dist };
      }
    });
    if (best) usedNaver.add(best.idx);

    return {
      id: `k${k.id}`,
      name: k.name,
      category: k.category,
      address: k.address,
      lat: k.lat,
      lng: k.lng,
      platforms: {
        kakao: {
          score: k.score,
          scoreCount: k.scoreCount,
          reviewCount: k.reviewCount,
          url: k.url,
        },
        naver: best
          ? {
              id: best.n.id,
              url: `https://m.place.naver.com/restaurant/${best.n.id}/home`,
              matchSim: Number(best.sim.toFixed(2)),
              matchDist: Math.round(best.dist),
              pending: true, // 별점/리뷰수는 클릭 시 조회
            }
          : null,
        diningcode: null, // 상위 결과만 서버에서 매칭해 채움
        google: null, // 키가 있으면 클릭 시 조회
      },
    };
  });

  // Kakao에 안 잡혔지만 Naver에만 있는 가게도 지도에 추가 (별점은 클릭 시)
  naverList.forEach((n, idx) => {
    if (usedNaver.has(idx)) return;
    merged.push({
      id: `n${n.id}`,
      name: n.name,
      category: n.category,
      address: n.address,
      lat: n.lat,
      lng: n.lng,
      platforms: {
        kakao: null,
        naver: {
          id: n.id,
          url: `https://m.place.naver.com/restaurant/${n.id}/home`,
          pending: true,
        },
        diningcode: null,
        google: null,
      },
    });
  });

  return merged;
}
