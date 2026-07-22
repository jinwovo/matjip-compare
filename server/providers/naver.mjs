// Naver 지도 (비공식). 두 단계로 나뉜다.
//  1) instant-search: 검색어 + 지도중심 좌표로 후보 장소(id/좌표/카테고리) 획득 — 빠름
//  2) place page: 특정 장소의 방문자 별점 / 방문자 리뷰수 / 블로그·카페 리뷰수 — 클릭 시에만
import { nameSimilarity, distanceMeters } from '../match.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function searchNaver(query, lat, lng, { signal } = {}) {
  const coords = isFinite(lat) && isFinite(lng) ? `${lat},${lng}` : '';
  const url = `https://map.naver.com/p/api/search/instant-search?query=${encodeURIComponent(
    query,
  )}&coords=${coords}`;
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': UA, Referer: 'https://map.naver.com/', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`naver search ${res.status}`);
  const json = await res.json();
  const places = Array.isArray(json.place) ? json.place : [];
  return places
    .map((p) => {
      const plat = Number(p.y);
      const plng = Number(p.x);
      if (!isFinite(plat) || !isFinite(plng)) return null;
      return {
        platform: 'naver',
        id: String(p.id ?? ''),
        name: p.title ?? '',
        category: p.ctg ?? '',
        address: p.roadAddress || p.jibunAddress || '',
        lat: plat,
        lng: plng,
      };
    })
    .filter(Boolean);
}

// 카카오 전용으로 잡힌 가게를 클릭할 때: 이름+좌표로 네이버에서 같은 가게를 찾아 별점 조회.
export async function naverRatingsByName(name, lat, lng, { signal } = {}) {
  const cands = await searchNaver(name, lat, lng, { signal });
  let best = null;
  let bestScore = -1;
  for (const c of cands) {
    const sim = nameSimilarity(name, c.name);
    const dist =
      isFinite(lat) && isFinite(lng) ? distanceMeters({ lat, lng }, c) : 0;
    const ok = sim >= 0.85 || (sim >= 0.5 && dist <= 120);
    if (!ok) continue;
    const s = sim - dist / 5000;
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  if (!best) return null;
  return naverRatings(best.id, { signal });
}

// 특정 네이버 플레이스의 별점/리뷰수 (m.place 페이지의 Apollo 상태에서 추출)
export async function naverRatings(id, { signal } = {}) {
  const url = `https://m.place.naver.com/restaurant/${encodeURIComponent(id)}/home`;
  const res = await fetch(url, {
    signal,
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  if (!res.ok) throw new Error(`naver place ${res.status}`);
  const html = await res.text();

  // PlaceDetailBase:{id} 객체 범위에서 필드를 뽑는다 (전체 Apollo JSON 파싱은 취약해서 지양)
  const base = sliceObject(html, `"PlaceDetailBase:${id}"`);
  const scope = base || html;

  const score = matchNum(scope, /"visitorReviewsScore":\s*"?([\d.]+)"?/);
  const visitor = matchNum(scope, /"visitorReviewsTotal":\s*"?(\d+)"?/);
  const blogCafe = matchNum(scope, /"cafeBlogReviewsTotal":\s*"?(\d+)"?/);
  const name = (scope.match(/"name":"((?:[^"\\]|\\.)*)"/) || [])[1];

  // 상세 정보: 한줄평, 편의시설, 대표 메뉴
  const microReview = firstQuoted(scope.match(/"microReviews":\[([^\]]*)\]/)?.[1]);
  const conveniences = allQuoted(scope.match(/"conveniences":\[([^\]]*)\]/)?.[1]).slice(0, 5);
  const menus = extractMenus(html, id, 3);

  // 영업 상태: "영업 중"/"영업 전"/"영업 종료" + 다음 변화 설명("22:00에 영업 종료")
  const bizM = html.match(
    /"businessStatusDescription":\{"__typename":"BusinessStatusDescription","status":"([^"]*)"(?:,"blindDescription":"([^"]*)")?(?:,"description":"([^"]*)")?/,
  );
  const openStatus = bizM && bizM[1] ? decodeUnicode(bizM[1]) : null;
  const openDesc = bizM ? decodeUnicode(bizM[3] || bizM[2] || '') || null : null;
  // 오늘 영업시간 문자열(있으면): "11:00 - 21:00" 형태
  const todayHours = extractTodayHours(html);

  return {
    platform: 'naver',
    id: String(id),
    name: name ? decodeUnicode(name) : null,
    score: score,                       // 방문자 리뷰 평균 별점 (5점 만점)
    scoreCount: visitor,                // 별점의 모수는 공개되지 않아 방문자 리뷰수로 대체
    reviewCount: visitor,               // 방문자 리뷰수
    blogReviewCount: blogCafe,          // 블로그+카페 리뷰수
    microReview,                        // 한줄평
    conveniences,                       // 편의시설
    menus,                              // 대표 메뉴 [{name, price}]
    openStatus,                         // 현재 영업 상태
    openDesc,                           // 다음 변화 설명
    todayHours,                         // 오늘 영업시간(있으면)
    url: `https://m.place.naver.com/restaurant/${id}/home`,
  };
}

// newBusinessHours 의 오늘 요일 영업시간을 뽑는다(구조가 취약해 실패 시 null).
function extractTodayHours(html) {
  const m = html.match(/"businessHours":\[?\{[^}]*"start":"(\d{1,2}:\d{2})"[^}]*"end":"(\d{1,2}:\d{2})"/);
  return m ? `${m[1]} - ${m[2]}` : null;
}

// "PlaceDetailBase:123" 키가 등장한 지점부터 중괄호 균형을 맞춰 해당 객체 문자열만 잘라낸다.
function sliceObject(html, keyToken) {
  const at = html.indexOf(keyToken);
  if (at === -1) return null;
  const brace = html.indexOf('{', at);
  if (brace === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = brace; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(brace, i + 1);
    }
  }
  return null;
}

// startAt 이후 첫 '{' 부터 중괄호 균형을 맞춰 객체 문자열을 잘라낸다.
function sliceObjectFrom(html, startAt) {
  const brace = html.indexOf('{', startAt);
  if (brace === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = brace; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(brace, i + 1);
    }
  }
  return null;
}

function firstQuoted(s) {
  if (!s) return null;
  const m = s.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? decodeUnicode(m[1]) : null;
}

function allQuoted(s) {
  if (!s) return [];
  return [...s.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => decodeUnicode(x[1]));
}

// 네이버 메뉴 가격 문자열을 정제 (여러 값이면 범위, 하나면 그대로, 숫자 없으면 null)
function formatPrice(raw) {
  if (raw == null) return null;
  const nums = String(raw).match(/\d[\d,]*/g);
  if (!nums) return null;
  const vals = [...new Set(nums.map((x) => Number(x.replace(/,/g, ''))).filter((v) => v > 0))].sort(
    (a, b) => a - b,
  );
  if (!vals.length) return null;
  const won = (v) => v.toLocaleString('ko-KR');
  return vals.length === 1 ? `${won(vals[0])}원` : `${won(vals[0])}~${won(vals[vals.length - 1])}원`;
}

// Apollo 상태의 Menu:{id}_N 객체들을 파싱해 대표 메뉴(추천 우선)를 뽑는다.
function extractMenus(html, id, limit) {
  const token = `"Menu:${id}_`;
  const menus = [];
  let from = 0;
  while (menus.length < 40) {
    const at = html.indexOf(token, from);
    if (at === -1) break;
    from = at + token.length;
    const objStr = sliceObjectFrom(html, at);
    if (!objStr) continue;
    try {
      const m = JSON.parse(objStr);
      if (m && m.name) {
        menus.push({
          name: m.name,
          price: formatPrice(m.price), // "50,000원" | "5,000~35,000원" | null
          recommend: !!m.recommend,
          image: (m.images && m.images[0]) || null,
        });
      }
    } catch (_) {}
  }
  menus.sort((a, b) => (b.recommend ? 1 : 0) - (a.recommend ? 1 : 0));
  return menus.slice(0, limit).map((m) => ({ name: m.name, price: m.price, image: m.image }));
}

function matchNum(s, re) {
  const m = s.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return isFinite(n) ? n : null;
}

function decodeUnicode(s) {
  return s.replace(/\\u002F/gi, '/').replace(/\\u([0-9a-f]{4})/gi, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
}
