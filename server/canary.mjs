// Provider 카나리 — 비공식 엔드포인트가 아직 데이터를 주는지 점검하는 스모크 테스트.
//   사용: npm run canary   (하나라도 실패하면 exit 1 → cron/CI에서 감지 가능)
// 네이버·카카오·다이닝코드는 비공식 웹 응답이라 언젠가 구조가 바뀌어 조용히 빈 결과가 날 수 있다.
// 이 스크립트로 "언제 깨졌는지"를 바로 알아챈다.
import { searchNaver, naverRatings } from './providers/naver.mjs';
import { searchKakao, geocodeKakao } from './providers/kakao.mjs';
import { searchDiningcode } from './providers/diningcode.mjs';

const GANGNAM = { lat: 37.4979, lng: 127.0276 };

const checks = [
  {
    name: 'naver-search',
    run: async () => {
      const r = await searchNaver('강남 맛집', GANGNAM.lat, GANGNAM.lng);
      if (!r.length) throw new Error('결과 0건');
      const p = r[0];
      if (!isFinite(p.lat) || !isFinite(p.lng)) throw new Error('좌표 없음');
      return `${r.length}곳 · 예: ${p.name} (${p.lat.toFixed(4)},${p.lng.toFixed(4)})`;
    },
  },
  {
    name: 'naver-ratings',
    run: async () => {
      const found = await searchNaver('농민백암순대', 37.5037, 127.053);
      const id = found[0]?.id;
      if (!id) throw new Error('테스트 대상 id 못 찾음');
      const d = await naverRatings(id);
      if (!(d.score > 0) && !(d.reviewCount > 0)) throw new Error('별점/리뷰 모두 없음');
      return `★${d.score ?? '-'} · 리뷰 ${d.reviewCount ?? 0} · 영업 "${d.openStatus ?? '-'}" · 사진 ${(d.photos || []).length}장`;
    },
  },
  {
    name: 'kakao-search',
    run: async () => {
      const r = await searchKakao('농민백암순대');
      if (!r.length) throw new Error('결과 0건');
      const p = r.find((x) => x.score > 0) || r[0];
      return `${r.length}곳 · 예: ${p.name} ★${p.score ?? '-'} 리뷰 ${p.reviewCount ?? 0}`;
    },
  },
  {
    name: 'kakao-geocode',
    run: async () => {
      const g = await geocodeKakao('속초');
      if (!g.found || !isFinite(g.lat)) throw new Error('지오코딩 실패');
      return `${g.label} (${g.lat.toFixed(3)},${g.lng.toFixed(3)}) · 반경 ${g.radius}m`;
    },
  },
  {
    name: 'diningcode',
    run: async () => {
      const r = await searchDiningcode('강남 맛집', GANGNAM.lat, GANGNAM.lng);
      if (!r.length) throw new Error('결과 0건');
      const p = r.find((x) => x.score > 0) || r[0];
      if (!(p.score > 0)) throw new Error('별점 없음');
      return `${r.length}곳 · 예: ${p.name} ★${p.score} 리뷰 ${p.reviewCount ?? 0} · 사진 ${(p.images || []).length}장`;
    },
  },
];

console.log('\n🔎 Provider 카나리 점검\n');
let pass = 0;
for (const c of checks) {
  const t0 = performance.now();
  try {
    const sample = await c.run();
    const ms = Math.round(performance.now() - t0);
    console.log(`  ✅ ${c.name.padEnd(14)} ${sample}  (${ms}ms)`);
    pass++;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    console.log(`  ❌ ${c.name.padEnd(14)} ${e.message}  (${ms}ms)`);
  }
}
const all = pass === checks.length;
console.log(`\n결과: ${pass}/${checks.length} 통과${all ? ' — 모든 소스 정상 ✓' : ' — 깨진 소스 있음! 재탐색 필요 ⚠️'}\n`);
process.exit(all ? 0 : 1);
