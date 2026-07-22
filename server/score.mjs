// 3사 별점을 하나의 "종합 점수"로 합치는 알고리즘.
//
// 핵심 아이디어 — 단순 평균의 함정 피하기:
//   리뷰 3개에 5.0★  vs  리뷰 3,000개에 4.4★  →  후자가 더 믿을 만하다.
// 그래서 각 플랫폼 별점을 베이지안 평균으로 보정한다(리뷰가 적을수록 전체 평균 C 쪽으로 끌어당김):
//   adj = (n·R + m·C) / (n + m)
//     R = 그 플랫폼의 별점, n = 별점/리뷰 수, C = 전체 평균 별점, m = 신뢰 임계치
// 그런 다음 플랫폼들을 리뷰 볼륨(log 가중)으로 통합해 최종 평점을 낸다.

const PLATFORMS = ['naver', 'kakao', 'diningcode', 'google'];
const M = 20; // 신뢰 임계치: 리뷰가 이 정도는 돼야 별점을 곧이곧대로 신뢰

export function computeScores(list) {
  // 1) 전체 평균 별점 C (사전 분포의 중심)
  let sum = 0;
  let cnt = 0;
  for (const r of list) {
    for (const p of PLATFORMS) {
      const d = r.platforms[p];
      if (d && d.score > 0) {
        sum += d.score;
        cnt++;
      }
    }
  }
  const C = cnt ? sum / cnt : 3.8;

  // 2) 가게별 종합 점수
  for (const r of list) {
    let wsum = 0;
    let wadj = 0;
    let reviews = 0;
    let best = 0;
    const used = [];

    for (const p of PLATFORMS) {
      const d = r.platforms[p];
      if (!d) continue;
      // 별점이 없어도(카카오 별점 미집계 등) 후기/리뷰 수는 총 리뷰 볼륨에 반영
      reviews += (d.reviewCount || 0) + (d.blogReviewCount || 0);
      if (!(d.score > 0)) continue;
      const n = d.scoreCount || d.reviewCount || 0; // 별점 모수(없으면 리뷰수로 대체)
      const adj = (n * d.score + M * C) / (n + M); // 베이지안 보정 별점
      const w = Math.log10(1 + n) || 0.1; // 리뷰 많을수록 크게(단 로그로 완만)
      wsum += w;
      wadj += w * adj;
      best = Math.max(best, d.score);
      used.push(p);
    }

    if (wsum > 0) {
      const rating = wadj / wsum; // 신뢰도 가중 종합 별점
      // 추천 점수 = 종합 별점 + 인기(총 리뷰) 보너스 + 여러 플랫폼에서 검증된 보너스
      const volumeBonus = Math.min(0.3, Math.log10(1 + reviews) / 12);
      const crossBonus = (used.length - 1) * 0.05; // 2사=+0.05, 3사=+0.10
      r.agg = {
        rating: round2(rating),
        recommend: round2(rating + volumeBonus + crossBonus),
        reviews,
        best: round2(best),
        platforms: used,
        confidence: used.length,
      };
    } else if (reviews > 0) {
      // 어느 플랫폼도 별점은 없지만 후기/리뷰 볼륨은 있는 경우(예: 카카오 후기만)
      // 별점은 null로 두되 리뷰수는 살려 리뷰순 정렬·표시에 반영한다.
      r.agg = { rating: null, recommend: -1, reviews, best: 0, platforms: [], confidence: 0 };
    } else {
      r.agg = null; // 별점도 후기도 없음
    }
  }
  return list;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
