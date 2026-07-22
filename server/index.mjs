import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKakao, geocodeKakao } from './providers/kakao.mjs';
import { searchNaver, naverRatings, naverRatingsByName } from './providers/naver.mjs';
import { searchDiningcode } from './providers/diningcode.mjs';
import { googleRating, hasGoogleKey } from './providers/google.mjs';
import { mergeKakaoNaver, nameSimilarity, distanceMeters } from './match.mjs';
import { computeScores } from './score.mjs';
import { aiBrief, ruleBrief, nlSearch, hasAiKey } from './providers/ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5178;

// --- 아주 단순한 TTL 메모리 캐시 (플랫폼에 예의 + 응답 속도 + 구글 과금 절약) ---
const cache = new Map();
function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = Promise.resolve()
    .then(producer)
    .catch((e) => {
      cache.delete(key); // 실패는 캐시하지 않음
      throw e;
    });
  cache.set(key, { t: now, v });
  return v;
}

// 동시 실행 개수를 제한하며 비동기 매핑 (플랫폼에 과부하 주지 않도록)
async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 검색: 카카오(별점 포함) + 네이버(후보) 를 병렬 조회 후 매칭
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!q) return res.status(400).json({ error: 'q(검색어)가 필요합니다' });

  try {
    const key = `search:${q}:${req.query.lat || ''}:${req.query.lng || ''}`;
    const data = await cached(key, 5 * 60_000, async () => {
      const [kakao, naver] = await Promise.all([
        searchKakao(q).catch((e) => (console.warn('kakao:', e.message), [])),
        searchNaver(q, lat, lng).catch((e) => (console.warn('naver:', e.message), [])),
      ]);
      const merged = mergeKakaoNaver(kakao, naver);

      // 종합 점수/추천 정렬을 위해 상위 결과의 네이버 별점 + 다이닝코드 별점을 미리 보강(캐시됨).
      const TOP = 14;
      await mapLimit(merged.slice(0, TOP), 6, async (r) => {
        try {
          if (r.platforms.naver?.id) {
            const rt = await cached(`naver:${r.platforms.naver.id}`, 30 * 60_000, () =>
              naverRatings(r.platforms.naver.id),
            );
            if (rt) Object.assign(r.platforms.naver, rt, { pending: false });
          }
          const dcList = await cached(`dc:${r.name}`, 30 * 60_000, () =>
            searchDiningcode(r.name, r.lat, r.lng),
          ).catch(() => []);
          const dc = bestDiningcodeMatch(dcList, r);
          if (dc)
            r.platforms.diningcode = {
              score: dc.score,
              scoreCount: dc.scoreCount,
              reviewCount: dc.reviewCount,
              dcScore: dc.dcScore,
              url: dc.url,
            };
        } catch (e) {
          console.warn('enrich-top:', e.message);
        }
      });

      computeScores(merged);
      merged.sort((a, b) => (b.agg?.recommend ?? -1) - (a.agg?.recommend ?? -1));
      return merged;
    });
    res.json({ query: q, count: data.length, googleEnabled: hasGoogleKey(), restaurants: data });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 클릭 시 보강: 네이버 별점/리뷰수 + (키 있으면) 구글 별점/리뷰수 병렬 조회
app.get('/api/enrich', async (req, res) => {
  const naverId = req.query.naverId ? String(req.query.naverId) : null;
  const name = String(req.query.name || '').trim();
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  try {
    const [naver, diningcode, google] = await Promise.all([
      naverId
        ? cached(`naver:${naverId}`, 30 * 60_000, () => naverRatings(naverId)).catch((e) => {
            console.warn('naverRatings:', e.message);
            return null;
          })
        : name
          ? cached(`naverByName:${name}:${req.query.lat || ''}:${req.query.lng || ''}`, 30 * 60_000, () =>
              naverRatingsByName(name, lat, lng),
            ).catch((e) => {
              console.warn('naverRatingsByName:', e.message);
              return null;
            })
          : null,
      name
        ? cached(`dc:${name}`, 30 * 60_000, () => searchDiningcode(name, lat, lng))
            .then((list) => {
              const dc = bestDiningcodeMatch(list, { name, lat, lng });
              return dc
                ? { score: dc.score, scoreCount: dc.scoreCount, reviewCount: dc.reviewCount, dcScore: dc.dcScore, url: dc.url }
                : null;
            })
            .catch((e) => {
              console.warn('diningcode:', e.message);
              return null;
            })
        : null,
      hasGoogleKey() && name
        ? cached(`google:${name}:${req.query.lat || ''}:${req.query.lng || ''}`, 6 * 60 * 60_000, () =>
            googleRating(name, lat, lng),
          ).catch((e) => {
            console.warn('googleRating:', e.message);
            return null;
          })
        : null,
    ]);
    res.json({ naver, diningcode, google });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 위치 기반 추천은 2단계로 나뉜다 (마커를 즉시 띄우고 별점은 뒤이어 채우기 위함).
// 1단계 /api/candidates: 격자 네이버 검색으로 후보(위치+이름)만 빠르게 — 별점 보강 없음.
app.get('/api/candidates', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const s = Number(req.query.minLat);
  const w = Number(req.query.minLng);
  const n = Number(req.query.maxLat);
  const e = Number(req.query.maxLng);
  const hasBox = [s, w, n, e].every(isFinite);
  if (!hasBox && !(isFinite(lat) && isFinite(lng)))
    return res.status(400).json({ error: 'lat/lng 또는 bbox(minLat..)가 필요합니다' });
  // 검색 키워드(자연어 검색이 넘겨줌). 없으면 '맛집' 전반.
  const q = (String(req.query.q || '').trim() || '맛집').slice(0, 40);

  try {
    const box = hasBox
      ? `${s.toFixed(3)}:${w.toFixed(3)}:${n.toFixed(3)}:${e.toFixed(3)}`
      : `${lat.toFixed(4)}:${lng.toFixed(4)}`;
    const key = `cand:${q}:${box}`;
    const restaurants = await cached(key, 5 * 60_000, async () => {
      const points = hasBox ? gridPoints(s, w, n, e) : [{ lat, lng }];
      const groups = await mapLimit(points, 8, (pt) =>
        searchNaver(q, pt.lat, pt.lng).catch(() => []),
      );
      const areaKm = hasBox ? distanceMeters({ lat: s, lng: w }, { lat: n, lng: e }) / 1000 : 0;
      const maxN = areaKm > 8 ? 60 : areaKm > 4 ? 45 : 25;
      const picked = pickSpread(groups, hasBox ? { s, w, n, e } : null, maxN);
      return picked.map((nv) => ({
        id: `n${nv.id}`,
        name: nv.name,
        category: nv.category,
        address: nv.address,
        lat: nv.lat,
        lng: nv.lng,
        platforms: {
          naver: { id: nv.id, url: `https://m.place.naver.com/restaurant/${nv.id}/home`, pending: true },
          kakao: null,
          diningcode: null,
          google: null,
        },
        agg: null,
      }));
    });
    res.json({ count: restaurants.length, googleEnabled: hasGoogleKey(), query: q, restaurants });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// 2단계 /api/enrich-batch: 후보들의 별점을 배치로 병렬 보강 (네이버 별점 + 카카오 매칭)
app.post('/api/enrich-batch', async (req, res) => {
  const places = Array.isArray(req.body?.places) ? req.body.places : [];
  if (!places.length) return res.json({ results: {} });
  try {
    const enriched = await mapLimit(places.slice(0, 80), 18, async (pl) => {
      const nid = pl.naverId || String(pl.id || '').replace(/^n/, '');
      if (!nid) return null;
      const r = await enrichPlace({
        id: nid,
        name: pl.name,
        category: pl.category,
        address: pl.address,
        lat: pl.lat,
        lng: pl.lng,
      });
      r.id = pl.id || r.id;
      return r;
    });
    const list = enriched.filter(Boolean);
    computeScores(list);
    const results = {};
    for (const r of list) results[r.id] = { platforms: r.platforms, agg: r.agg };
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// 네이버 후보 하나에 카카오 + 다이닝코드 별점 매칭 + 네이버 별점 보강 → 통합 레스토랑 객체
async function enrichPlace(n) {
  const [kakaoList, dcList, nr] = await Promise.all([
    searchKakao(n.name).catch(() => []),
    cached(`dc:${n.name}`, 30 * 60_000, () => searchDiningcode(n.name, n.lat, n.lng)).catch(() => []),
    cached(`naver:${n.id}`, 30 * 60_000, () => naverRatings(n.id)).catch(() => null),
  ]);
  const k = bestKakaoMatch(kakaoList, n);
  const dc = bestDiningcodeMatch(dcList, n);
  return {
    id: `n${n.id}`,
    name: n.name,
    category: n.category,
    address: n.address,
    lat: n.lat,
    lng: n.lng,
    platforms: {
      naver: nr
        ? { ...nr, id: n.id, pending: false }
        : { id: n.id, url: `https://m.place.naver.com/restaurant/${n.id}/home`, pending: false },
      kakao: k ? { score: k.score, scoreCount: k.scoreCount, reviewCount: k.reviewCount, url: k.url } : null,
      diningcode: dc
        ? { score: dc.score, scoreCount: dc.scoreCount, reviewCount: dc.reviewCount, dcScore: dc.dcScore, url: dc.url }
        : null,
      google: null,
    },
  };
}

// 영역을 격자로 나눈 지점들 (넓을수록 촘촘히: 1x1 → 2x2 → 3x3)
function gridPoints(s, w, n, e) {
  const km = distanceMeters({ lat: s, lng: w }, { lat: n, lng: e }) / 1000;
  // 격자 최대 3x3(=네이버 9회)로 제한 — 검색 속도 우선
  const g = km > 5 ? 3 : km > 1.5 ? 2 : 1;
  const pts = [];
  for (let i = 0; i < g; i++)
    for (let j = 0; j < g; j++)
      pts.push({ lat: s + ((n - s) * (i + 0.5)) / g, lng: w + ((e - w) * (j + 0.5)) / g });
  return pts;
}

// 여러 지점 결과를 영역 필터 + 중복 제거 후, 지점별로 번갈아 뽑아 지리적 분산 확보
function pickSpread(groups, box, max) {
  const seen = new Set();
  const cleaned = groups.map((g) =>
    g.filter((p) => {
      if (box && !(p.lat >= box.s && p.lat <= box.n && p.lng >= box.w && p.lng <= box.e)) return false;
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    }),
  );
  const out = [];
  for (let idx = 0; out.length < max; idx++) {
    let added = false;
    for (const g of cleaned) {
      if (g[idx]) {
        out.push(g[idx]);
        added = true;
        if (out.length >= max) break;
      }
    }
    if (!added) break;
  }
  return out;
}

// 네이버 가게 하나에 가장 잘 맞는 카카오 후보 찾기 (이름 유사도 + 좌표 거리)
function bestKakaoMatch(kakaoList, n) {
  return bestByNameDist(kakaoList, n);
}

// 네이버 가게 하나에 가장 잘 맞는 다이닝코드 후보 찾기 (동일 기준)
function bestDiningcodeMatch(dcList, n) {
  return bestByNameDist(dcList, n);
}

// 공통: 이름 유사도 + 좌표 거리로 같은 가게 후보 고르기
function bestByNameDist(list, n) {
  let best = null;
  let bestScore = -1;
  for (const c of list) {
    const sim = nameSimilarity(n.name, c.name);
    const dist = distanceMeters(n, c);
    const ok = (sim >= 0.85 && dist <= 200) || (sim >= 0.6 && dist <= 100) || (sim >= 0.45 && dist <= 40);
    if (!ok) continue;
    const s = sim - dist / 5000;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

// AI 지역 브리핑: 현재 화면의 맛집 목록을 Claude가 요약(키 없으면 규칙 기반 폴백)
app.post('/api/brief', async (req, res) => {
  const area = String(req.body?.area || '이 지역').slice(0, 40);
  const places = Array.isArray(req.body?.places) ? req.body.places.slice(0, 40) : [];
  if (!places.length) return res.json({ brief: '먼저 지도에서 맛집을 찾아주세요.', source: 'none' });
  try {
    if (hasAiKey()) {
      const text = await aiBrief(area, places);
      if (text) return res.json({ brief: text, source: 'ai' });
    }
  } catch (e) {
    console.warn('aiBrief:', e.message);
  }
  res.json({ brief: ruleBrief(area, places), source: 'rule' });
});

// 자연어 검색: 문장 → 지도 검색 키워드 (키 없으면 입력어 그대로)
app.post('/api/nl-search', async (req, res) => {
  const query = String(req.body?.query || '').trim().slice(0, 200);
  if (!query) return res.status(400).json({ error: 'query가 필요합니다' });
  try {
    if (hasAiKey()) {
      const r = await nlSearch(query);
      if (r && r.keyword) return res.json({ keyword: r.keyword, note: r.note, ai: true });
    }
  } catch (e) {
    console.warn('nlSearch:', e.message);
  }
  res.json({ keyword: query, note: '', ai: false });
});

// 지역명 검색: "속초"/"속초 초밥"/"홍대" 등을 좌표+키워드로 해석해 지도 이동에 쓴다.
// 규칙: A) 전체가 공식 지역이면 keyword='맛집'  B) 여러 단어면 앞=지역·끝=키워드
//       C) 단일 콜로퀴얼 장소(음식어 아님)는 대표 장소로  D) 실패 시 현재 화면에서 그대로 검색
const FOOD_WORD =
  /맛집|음식|초밥|스시|오마카세|회|물회|해산물|대게|장어|닭강정|파스타|피자|햄버거|버거|치킨|카페|디저트|베이커리|빵|커피|브런치|와플|케이크|고기|삼겹|갈비|곱창|막창|족발|보쌈|한우|스테이크|국밥|해장|샤브|전골|찌개|국수|칼국수|냉면|막국수|라멘|우동|소바|돈카츠|돈까스|쌀국수|중식|짜장|짬뽕|마라|훠궈|양꼬치|딤섬|분식|떡볶이|김밥|순대|술집|이자카야|포차|호프|맥주|와인|한식|백반|한정식|정식|비빔밥|덮밥|불고기|닭갈비|감자탕/;

app.get('/api/locate', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 50);
  if (!q) return res.status(400).json({ error: 'q(검색어)가 필요합니다' });
  try {
    const data = await cached(`locate:${q}`, 30 * 60_000, async () => {
      const tokens = q.split(/\s+/).filter(Boolean);
      const geo = (s, placeFallback) =>
        geocodeKakao(s, { placeFallback }).catch(() => ({ found: false }));

      // A) 전체가 공식 행정구역
      let g = await geo(q, false);
      if (g.found) return { ...g, keyword: '맛집' };

      // B) 여러 단어: 앞부분=지역(장소 폴백 허용), 마지막 단어=키워드
      if (tokens.length >= 2) {
        g = await geo(tokens.slice(0, -1).join(' '), true);
        if (g.found) return { ...g, keyword: tokens[tokens.length - 1] };
      }

      // C) 단일 콜로퀴얼 장소 (음식 단어가 아닐 때만: "홍대"○ / "초밥"✗)
      if (tokens.length === 1 && !FOOD_WORD.test(q)) {
        g = await geo(q, true);
        if (g.found) return { ...g, keyword: '맛집' };
      }

      // D) 지역으로 못 잡음 → 현재 화면에서 입력어 그대로 검색
      return { found: false, keyword: q };
    });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, google: hasGoogleKey(), ai: hasAiKey() }),
);

app.listen(PORT, () => {
  console.log(`\n  🍚 맛집비교 지도 실행 중  →  http://localhost:${PORT}\n`);
  console.log(`  구글 Places: ${hasGoogleKey() ? '사용 (키 감지됨)' : '미설정 (네이버·카카오만 표시)'}\n`);
});
