/* 맛집비교 지도 — 프런트엔드 (Leaflet + 백엔드 /api) */
const PLATFORMS = [
  { key: 'naver', label: '네이버', color: '#03c75a' },
  { key: 'kakao', label: '카카오', color: '#ffcd00' },
  { key: 'diningcode', label: '다이닝코드', color: '#ff6d00' },
  { key: 'google', label: '구글', color: '#4285f4' },
];
// 구글 키가 없으면 구글은 숨김 (키를 넣으면 자동으로 다시 표시됨)
function activePlatforms() {
  return PLATFORMS.filter((p) => p.key !== 'google' || state.googleEnabled);
}

const state = {
  restaurants: [],
  markers: new Map(), // id -> marker
  selectedId: null,
  googleEnabled: false,
  sort: 'recommend', // recommend | rating | reviews | near
  catFilter: null, // 카테고리 필터 (null = 전체)
  favorites: new Map(), // id -> restaurant (localStorage 저장)
  showFavs: false, // 즐겨찾기만 보기
  origin: null, // 거리 기준점 (내 위치). 없으면 지도 중심 사용
  minRating: 0, // 별점 필터 (0 = 전체)
  minReviews: 0, // 리뷰수 필터 (0 = 전체)
};

// 거리 기준점: 내 위치가 있으면 그걸, 없으면 현재 지도 중심
function originPoint() {
  return state.origin || map.getCenter();
}
// 기준점에서 가게까지 거리(m) — Leaflet 내장 거리 계산 사용
function distMeters(r) {
  if (!isFinite(r.lat) || !isFinite(r.lng)) return Infinity;
  const o = originPoint();
  return map.distance([o.lat, o.lng], [r.lat, r.lng]);
}
function distFmt(m) {
  if (!isFinite(m)) return '';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

// --- 즐겨찾기 (localStorage) ---
function loadFavs() {
  try {
    const arr = JSON.parse(localStorage.getItem('goodrest:favs') || '[]');
    return new Map(arr.map((r) => [r.id, r]));
  } catch (_) {
    return new Map();
  }
}
function saveFavs() {
  try {
    localStorage.setItem('goodrest:favs', JSON.stringify([...state.favorites.values()]));
  } catch (_) {}
}
function findRestaurant(id) {
  return state.restaurants.find((x) => x.id === id) || state.favorites.get(id);
}
function toggleFav(r) {
  if (state.favorites.has(r.id)) state.favorites.delete(r.id);
  else state.favorites.set(r.id, r);
  saveFavs();
  renderMarkers();
  // 상세를 보는 중이면 목록으로 튕기지 않고 하트만 갱신
  if (!el('detail').hidden && state.selectedId === r.id) updateFavBtn(r);
  else renderList();
}
function updateFavBtn(r) {
  const on = state.favorites.has(r.id);
  const b = el('favDetailBtn');
  b.textContent = on ? '★' : '☆';
  b.classList.toggle('on', on);
}

// --- 지도 초기화 (기본: 서울 강남역) ---
const map = L.map('map', { zoomControl: true }).setView([37.4979, 127.0276], 14);
// 밝고 깔끔한 미니멀 타일 (도로·지명은 잘 보이면서 건물/POI 잡동사니는 적음)
L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
  maxZoom: 20,
  subdomains: 'abcd',
  attribution: '© OpenStreetMap · © CARTO',
}).addTo(map);

// 마커 클러스터 그룹 (가까운 핀을 묶어 겹침 정리)
// 애니메이션/스파이더파이 도중 재렌더로 내부 상태가 꼬이면 새로 만들어 복구하므로 let.
let clusterGroup = makeClusterGroup();
function makeClusterGroup() {
  return L.markerClusterGroup({
    // 줌이 깊을수록 덜 묶는다 — 초점 뷰(z14+)에선 거의 겹친 핀만 묶고 나머진 개별로,
    // 지역 검색처럼 줌아웃(z≤12)했을 때만 크게 뭉친다.
    maxClusterRadius: (z) => (z >= 15 ? 8 : z >= 14 ? 14 : z >= 12 ? 34 : 55),
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    // 결과가 소량(≤60)이라 화면 밖 마커 컬링은 불필요. 켜두면 fitBounds 점프 직후
    // 새 그룹이 갱신되지 않아 마커가 1개만 보이는 문제가 생겨 끈다.
    removeOutsideVisibleBounds: false,
    iconCreateFunction: clusterIcon,
  }).addTo(map);
}

function clusterIcon(cluster) {
  const n = cluster.getChildCount();
  const size = n < 10 ? 38 : n < 50 ? 46 : 54;
  return L.divIcon({
    className: 'cl-wrap',
    html: `<div class="cl" style="width:${size}px;height:${size}px">${n}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const el = (id) => document.getElementById(id);
const panel = el('panel');

// --- 검색 ---
el('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el('searchInput').value.trim();
  if (!q) return;
  await runSearch(q);
});

// 자연어 검색: 문장 → AI가 키워드로 변환 → 현재 지도 영역에서 찾기
async function runNlSearch(query) {
  if (!query) return;
  const btn = el('nlBtn');
  btn.disabled = true;
  btn.textContent = '⏳';
  try {
    const nl = await fetch('/api/nl-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    }).then((r) => r.json());
    const b = map.getBounds();
    const p = new URLSearchParams({
      minLat: b.getSouth(),
      minLng: b.getWest(),
      maxLat: b.getNorth(),
      maxLng: b.getEast(),
      q: nl.keyword,
    });
    await loadCandidates('/api/candidates?' + p.toString());
    const note = el('nlNote');
    note.hidden = false;
    note.innerHTML = `<b>‘${esc(nl.keyword)}’</b>${nl.note ? ' · ' + esc(nl.note) : ''}`;
  } catch (e) {
    console.warn('nl:', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨';
  }
}
el('nlBtn').addEventListener('click', () => runNlSearch(el('searchInput').value.trim()));

// 내 위치로 지도 이동
el('locBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('이 브라우저에서는 위치 기능을 쓸 수 없어요.');
  const btn = el('locBtn');
  btn.textContent = '⏳';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.origin = { lat: pos.coords.latitude, lng: pos.coords.longitude }; // 거리 기준점
      map.setView([pos.coords.latitude, pos.coords.longitude], 16);
      btn.textContent = '📍';
      if (state.restaurants.length) renderList(); // 거리 표시 갱신
    },
    () => {
      alert('위치를 가져오지 못했어요. 브라우저 위치 권한을 확인해주세요.');
      btn.textContent = '📍';
    },
    { enableHighAccuracy: true, timeout: 8000 },
  );
});

// 검색: "속초"/"속초 초밥"/"홍대" 같은 지역명을 해석해 그 지역으로 지도를 옮긴 뒤
// 해당 영역의 맛집을 불러온다. 지역으로 못 잡으면 현재 화면에서 입력어로 검색.
async function runSearch(q) {
  if (!q) return;
  setBusy(true);
  try {
    const loc = await fetch('/api/locate?q=' + encodeURIComponent(q))
      .then((r) => r.json())
      .catch(() => ({ found: false, keyword: q }));
    if (loc.found && isFinite(loc.lat) && isFinite(loc.lng)) {
      // 반경(시=20km ~ 동=1km)에 맞춰 줌 결정. animate:false 로 즉시 이동(마커 재렌더 안전).
      const z = loc.radius >= 12000 ? 13 : loc.radius >= 4000 ? 14 : 15;
      map.setView([loc.lat, loc.lng], z, { animate: false });
    }
    const b = map.getBounds();
    const p = new URLSearchParams({
      minLat: b.getSouth(),
      minLng: b.getWest(),
      maxLat: b.getNorth(),
      maxLng: b.getEast(),
      q: loc.keyword || '맛집',
    });
    await loadCandidates('/api/candidates?' + p.toString());
    const note = el('nlNote');
    note.hidden = false;
    note.innerHTML = `<b>${esc(loc.found ? loc.label : '현재 지도')}</b> · ${esc(loc.keyword || '맛집')}`;
  } catch (err) {
    alert('검색 오류: ' + err.message);
  } finally {
    setBusy(false);
  }
}

// 위치 기반: 지도 중심 근처의 맛집을 검색어 없이 불러온다 (현재 뷰는 유지)
async function nearby(lat, lng) {
  await loadCandidates(`/api/candidates?lat=${lat}&lng=${lng}`);
}

// 화면 영역(bbox) 전체의 맛집을 격자 검색으로 불러온다
async function nearbyArea(bounds) {
  const p = new URLSearchParams({
    minLat: bounds.getSouth(),
    minLng: bounds.getWest(),
    maxLat: bounds.getNorth(),
    maxLng: bounds.getEast(),
  });
  await loadCandidates('/api/candidates?' + p.toString());
}

// 2단계 로딩: (1) 후보 마커를 즉시 표시 → (2) 별점을 배치로 보강해 갱신
async function loadCandidates(url) {
  setBusy(true);
  showLoading();
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '불러오기 실패');
    state.googleEnabled = data.googleEnabled;
    state.restaurants = data.restaurants;
    state.catFilter = null;
    renderMarkers(); // 후보 마커 즉시 (별점 없이 위치만)
    renderList();
    await enrichBatch(); // 별점 배치 보강 후 갱신
  } catch (err) {
    console.warn('nearby:', err.message);
  } finally {
    setBusy(false);
  }
}

async function enrichBatch() {
  const snapshot = state.restaurants;
  const places = snapshot.map((r) => ({
    id: r.id,
    naverId: r.platforms.naver?.id,
    name: r.name,
    category: r.category,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
  }));
  if (!places.length) return;
  try {
    const res = await fetch('/api/enrich-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ places }),
    });
    const data = await res.json();
    if (state.restaurants !== snapshot) return; // 그 사이 새 검색이 시작됐으면 무시
    for (const r of state.restaurants) {
      const en = data.results?.[r.id];
      if (en) {
        r.platforms = en.platforms;
        r.agg = en.agg;
      }
    }
    renderMarkers();
    renderList();
  } catch (err) {
    console.warn('enrich:', err.message);
  }
}

function setBusy(b) {
  el('searchBtn').disabled = b;
  el('searchBtn').textContent = b ? '…' : '검색';
}

// --- 마커 ---
function renderMarkers() {
  state.markers.clear();

  const layers = [];
  for (const r of visibleRestaurants()) {
    if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue; // 좌표 이상치 방어
    const sel = r.id === state.selectedId;
    const marker = L.marker([r.lat, r.lng], { icon: pinIcon(r, sel) });
    if (sel) marker.setZIndexOffset(1000);
    marker.on('click', () => selectRestaurant(r.id));
    marker.bindTooltip(r.name, { direction: 'bottom', offset: [0, 4], className: 'mk-tip' });
    state.markers.set(r.id, marker);
    layers.push(marker);
  }

  // 매 렌더마다 클러스터 그룹을 통째로 교체한다.
  // 이유: clearLayers()+addLayers() 로 재사용하면, 이전 검색의 fitBounds 줌 애니메이션이
  // 아직 진행 중일 때 클러스터 트리가 갈려 나가고, 그 애니메이션이 끝나는 순간(_zoomEnd →
  // _animationZoomOut) 사라진 레이어를 참조해 "_leaflet_id in undefined" 로 죽는다(속초처럼
  // 먼 곳 검색 = 큰 줌 점프 = 긴 애니메이션 창에서 재검색 시 재현). removeLayer 로 옛 그룹을
  // 지도에서 떼면 그 그룹은 줌 이벤트에서 분리돼 더 이상 처리되지 않으므로 원천 차단된다.
  try { map.removeLayer(clusterGroup); } catch (_) {}
  clusterGroup = makeClusterGroup();
  clusterGroup.addLayers(layers);
}

// 대표 별점(가진 것 중 가장 높은 값)으로 핀 라벨 구성
// 카테고리 → 음식 이모지 (키워드 우선순위 매칭)
const CATEGORY_ICONS = [
  [/카페|디저트|베이커리|빵|커피|브런치|와플|케이크|도넛/, '☕'],
  [/피자/, '🍕'],
  [/햄버거|버거/, '🍔'],
  [/치킨|닭/, '🍗'],
  [/초밥|스시|일식|돈카츠|돈까스|라멘|우동|오마카세|사케|규동|덮밥/, '🍣'],
  [/중식|중국|마라|훠궈|양꼬치|딤섬|짜장|짬뽕/, '🥟'],
  [/파스타|이탈리|양식|스테이크|리조또|프랑스|스페인/, '🍝'],
  [/샤브|전골|찌개|국밥|해장|탕|국물|곰탕|설렁탕|순대국/, '🍲'],
  [/삼겹|고기|구이|갈비|정육|바베큐|곱창|막창|족발|보쌈|한우/, '🍖'],
  [/회|해산물|수산|생선|물회|조개|굴|장어|초장/, '🐟'],
  [/분식|떡볶이|김밥|순대/, '🍢'],
  [/국수|면|칼국수|냉면|쌀국수|소바/, '🍜'],
  [/술|포차|이자카야|바|호프|맥주|와인|위스키|펍/, '🍺'],
  [/한식|백반|한정식|비빔밥|정식|쌈|불고기|닭갈비/, '🍚'],
];
function categoryIcon(cat) {
  const c = cat || '';
  for (const [re, icon] of CATEGORY_ICONS) if (re.test(c)) return icon;
  return '🍽️';
}

// 평점별 색이 다른 알약(pill) 마커 — 상위(초록)/양호(주황)/보통(회색)/무평점
function pinIcon(r, selected) {
  const s = r.agg?.rating ?? bestScore(r);
  const label = s != null ? s.toFixed(1) : '·';
  const v = s == null ? null : parseFloat(label); // 표시 숫자 기준으로 색 결정(색·숫자 일치)
  const tier = v == null ? 'na' : v >= 4.5 ? 'top' : v >= 4.0 ? 'good' : 'mid';
  const html = `<div class="mk mk-${tier}${selected ? ' mk-sel' : ''}"><span class="mk-cat">${categoryIcon(r.category)}</span><span class="mk-val">${label}</span></div>`;
  const w = selected ? 60 : 54;
  const h = selected ? 34 : 30;
  return L.divIcon({
    className: 'mk-wrap',
    html,
    iconSize: [w, h + 8],
    iconAnchor: [w / 2, h + 8],
    popupAnchor: [0, -(h + 4)],
  });
}

function bestScore(r) {
  const vals = [];
  if (r.platforms.kakao?.score) vals.push(r.platforms.kakao.score);
  if (r.platforms.naver?.score) vals.push(r.platforms.naver.score);
  if (r.platforms.diningcode?.score) vals.push(r.platforms.diningcode.score);
  if (r.platforms.google?.score) vals.push(r.platforms.google.score);
  return vals.length ? Math.max(...vals) : null;
}

// 영업 상태 (네이버 businessStatusDescription 기반)
function openInfo(r) {
  const s = r.platforms.naver?.openStatus;
  if (!s) return null;
  const open = /영업\s*중/.test(s);
  const soon = /곧/.test(s);
  return {
    open,
    soon,
    desc: r.platforms.naver?.openDesc || '',
    label: open ? (soon ? '곧 마감' : '영업중') : /전/.test(s) ? '영업전' : '영업종료',
    cls: open ? (soon ? 'soon' : 'open') : 'closed',
  };
}
function openBadge(r) {
  const o = openInfo(r);
  return o ? ` <span class="open-badge ${o.cls}">${o.label}</span>` : '';
}

function fitToMarkers() {
  const pts = visibleRestaurants().map((r) => [r.lat, r.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [50, 50], maxZoom: 16 });
}

// --- 목록 ---
function visibleRestaurants() {
  let list = state.showFavs ? [...state.favorites.values()] : state.restaurants;
  if (state.catFilter) list = list.filter((r) => (r.category || '').includes(state.catFilter));
  // 별점·리뷰 최소 기준 필터 (#4)
  if (state.minRating > 0) list = list.filter((r) => (r.agg?.rating ?? 0) >= state.minRating);
  if (state.minReviews > 0) list = list.filter((r) => (r.agg?.reviews ?? 0) >= state.minReviews);

  list = [...list];
  if (state.sort === 'near') {
    list.sort((a, b) => distMeters(a) - distMeters(b)); // 가까운순(오름차순)
  } else if (state.sort === 'now') {
    // "지금" — 영업중(강한 가산) + 가까움(거리 페널티) + 종합점수 를 blend
    const nowScore = (r) => {
      const base = r.agg?.recommend ?? -1;
      const pen = Math.min(0.6, (distMeters(r) / 1000) * 0.12); // km당 -0.12, 최대 -0.6
      const openBonus = openInfo(r)?.open ? 1.5 : 0; // 영업중이면 확실히 위로
      return base - pen + openBonus;
    };
    list.sort((a, b) => nowScore(b) - nowScore(a));
  } else {
    const key = state.sort;
    const val = (r) => {
      if (!r.agg) return -1;
      if (key === 'reviews') return r.agg.reviews;
      if (key === 'rating') return r.agg.rating ?? -1;
      return r.agg.recommend ?? -1;
    };
    list.sort((a, b) => val(b) - val(a));
  }
  return list;
}

// 결과에서 자주 나오는 카테고리(첫 토큰)를 뽑아 필터 칩으로
function topCategories(list) {
  const count = {};
  for (const r of list) {
    const c = (r.category || '').split(/[,/·]/)[0].trim();
    if (c) count[c] = (count[c] || 0) + 1;
  }
  return Object.entries(count)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map((e) => e[0]);
}

function renderCatBar() {
  const bar = el('catBar');
  const source = state.showFavs ? [...state.favorites.values()] : state.restaurants;
  const cats = topCategories(source);
  if (cats.length < 2) {
    bar.innerHTML = '';
    return;
  }
  const chips = [['전체', ''], ...cats.map((c) => [c, c])];
  bar.innerHTML = chips
    .map(
      ([label, val]) =>
        `<button type="button" class="chip cat${(state.catFilter || '') === val ? ' active' : ''}" data-cat="${esc(val)}">${esc(label)}</button>`,
    )
    .join('');
  bar.querySelectorAll('.chip').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.catFilter = btn.dataset.cat || null;
      renderMarkers();
      renderList();
    }),
  );
}

// 로딩 중 스켈레톤 (넓은 영역 검색은 몇 초 걸리므로 피드백 제공)
function showLoading() {
  el('panelHint').hidden = true;
  el('detail').hidden = true;
  el('listSection').hidden = false;
  panel.classList.remove('empty');
  el('catBar').innerHTML = '';
  el('nlNote').hidden = true;
  el('briefBtn').hidden = true;
  el('briefCard').hidden = true;
  el('resultCount').textContent = '불러오는 중…';
  el('list').innerHTML = Array.from({ length: 6 })
    .map(
      () =>
        '<li class="list-item skel"><div class="rank skel-box"></div><div class="li-main"><div class="skel-line w70"></div><div class="skel-line w40"></div></div></li>',
    )
    .join('');
}

function renderList() {
  el('panelHint').hidden = true;
  el('detail').hidden = true;
  const sec = el('listSection');
  sec.hidden = false;
  panel.classList.remove('empty');
  renderCatBar();
  const items = visibleRestaurants();
  el('briefBtn').hidden = !items.length;
  const total = state.showFavs ? state.favorites.size : state.restaurants.length;
  el('resultCount').textContent = state.catFilter ? `${items.length}곳 / 전체 ${total}` : `${total}곳`;

  const ul = el('list');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = state.showFavs
      ? '<li class="empty-msg">즐겨찾기가 비어 있어요.<br>가게의 ☆를 눌러 추가해보세요.</li>'
      : '<li class="empty-msg">결과가 없어요.<br>다른 검색어나 카테고리를 시도해보세요.</li>';
    return;
  }
  items.forEach((r, i) => {
    const agg = r.agg;
    const rank = i + 1;
    const fav = state.favorites.has(r.id);
    const dist = distFmt(distMeters(r));
    const li = document.createElement('li');
    li.className = 'list-item' + (r.id === state.selectedId ? ' active' : '');
    li.innerHTML = `
      <div class="rank-cell">
        <div class="rank rank-${rank <= 3 ? rank : 'n'}">${rank}</div>
        <span class="li-cat-ic" title="${esc(r.category || '')}">${categoryIcon(r.category)}</span>
      </div>
      <div class="li-main">
        <div class="li-name">${esc(r.name)}</div>
        <div class="li-cat">${esc(r.category || '')}${agg?.reviews ? ' · 리뷰 ' + fmt(agg.reviews) : ''}${dist ? ` · <span class="li-dist">${dist}</span>` : ''}${openBadge(r)}</div>
        <div class="li-badges">${miniBadges(r)}</div>
      </div>
      <div class="li-score">
        <div class="li-agg">${agg && agg.rating != null ? agg.rating.toFixed(1) : '–'}<span>★</span></div>
        <div class="li-conf">${agg ? (agg.rating != null ? agg.confidence + '사 종합' : '후기 ' + fmt(agg.reviews)) : ''}</div>
      </div>
      <button class="fav-btn${fav ? ' on' : ''}" title="즐겨찾기">${fav ? '★' : '☆'}</button>`;
    li.addEventListener('click', () => selectRestaurant(r.id));
    li.querySelector('.fav-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFav(r);
    });
    ul.appendChild(li);
  });
}

function miniBadges(r) {
  return activePlatforms().map((p) => {
    const d = r.platforms[p.key];
    const has = d && d.score != null;
    const pending = d && d.pending;
    const txt = has ? d.score.toFixed(1) : pending ? '…' : '–';
    return `<span class="mini" style="--c:${p.color}" title="${p.label}">${p.label[0]} ${txt}</span>`;
  }).join('');
}

// --- 상세 (플랫폼 비교 카드) ---
async function selectRestaurant(id) {
  const prevId = state.selectedId;
  state.selectedId = id;
  const r = findRestaurant(id);
  if (!r) return;

  // 이전 선택 마커 원복 + 새 선택 마커 강조/확대
  if (prevId && prevId !== id) {
    const pm = state.markers.get(prevId);
    const pr = findRestaurant(prevId);
    if (pm && pr) {
      pm.setIcon(pinIcon(pr, false));
      pm.setZIndexOffset(0);
    }
  }
  // 클러스터에 묶여 있으면 펼쳐 보여준 뒤 강조 (재렌더로 마커가 교체됐을 수 있어 방어적으로)
  const mk = state.markers.get(id);
  if (mk) {
    try {
      clusterGroup.zoomToShowLayer(mk, () => {
        if (state.markers.get(id) !== mk) return; // 그 사이 재렌더됐으면 무시
        mk.setIcon(pinIcon(r, true));
        mk.setZIndexOffset(1000);
        mk.openTooltip();
      });
    } catch (_) {
      map.panTo([r.lat, r.lng]);
    }
  } else {
    map.panTo([r.lat, r.lng]);
  }

  el('panelHint').hidden = true;
  el('listSection').hidden = true;
  const d = el('detail');
  d.hidden = false;
  panel.classList.remove('empty');

  el('detailName').textContent = r.name;
  updateFavBtn(r);
  el('favDetailBtn').onclick = () => toggleFav(r);
  el('detailMeta').textContent = [r.category, r.address].filter(Boolean).join(' · ');
  renderDetailAgg(r);
  el('matchNote').textContent = '';
  renderDetailExtras(r);

  // 보강이 필요한 플랫폼 파악 (네이버 별점 + 구글). 네이버는 카카오 전용 가게도 이름으로 재시도.
  const naverUnknown = !r.platforms.naver || r.platforms.naver.pending;
  const needNaver = naverUnknown && !r._naverTried;
  const needGoogle = state.googleEnabled && !r.platforms.google;
  const willEnrich = needNaver || needGoogle;

  const loading = new Set();
  if (needNaver) loading.add('naver');
  if (needGoogle) loading.add('google');
  // 보강 호출이 어차피 나가는데 다이닝코드가 비어 있으면 스피너 표시(추가 호출 없음)
  if (willEnrich && !r.platforms.diningcode) loading.add('diningcode');
  renderCompare(r, loading);

  if (willEnrich) {
    try {
      const params = new URLSearchParams({ name: r.name, lat: r.lat, lng: r.lng });
      if (r.platforms.naver?.id) params.set('naverId', r.platforms.naver.id);
      const res = await fetch('/api/enrich?' + params.toString());
      const data = await res.json();
      r._naverTried = true;
      if (data.naver) {
        r.platforms.naver = { ...(r.platforms.naver || {}), ...data.naver, pending: false };
      } else if (r.platforms.naver) {
        r.platforms.naver.pending = false;
      }
      if (data.diningcode) r.platforms.diningcode = data.diningcode;
      if (data.google) r.platforms.google = data.google;
    } catch (_) {
      r._naverTried = true;
      if (r.platforms.naver) r.platforms.naver.pending = false;
    }
  }

  if (state.selectedId === id) {
    computeAgg(r); // 보강된 네이버/구글 반영해 종합 재계산
    renderCompare(r, new Set());
    renderDetailAgg(r);
    // 별점 갱신됐으면 핀 라벨도 갱신
    const mk2 = state.markers.get(id);
    if (mk2) mk2.setIcon(pinIcon(r, true));
    renderMatchNote(r);
    renderDetailExtras(r);
  }
}

function renderCompare(r, loadingSet) {
  const rows = activePlatforms().map((p) => compareRow(p, r.platforms[p.key], loadingSet.has(p.key))).join('');
  el('compare').innerHTML = rows;
}

function compareRow(p, d, pending) {
  const disabled = p.key === 'google' && !state.googleEnabled && !d;
  if (disabled) {
    return `<div class="row disabled" style="--c:${p.color}">
      <div class="row-plat">${p.label}</div>
      <div class="row-body muted">API 키 미설정</div></div>`;
  }
  if (pending) {
    return `<div class="row" style="--c:${p.color}">
      <div class="row-plat">${p.label}</div>
      <div class="row-body"><span class="spinner"></span> 불러오는 중…</div></div>`;
  }
  if (!d || (d.score == null && !d.reviewCount)) {
    const link = d?.url
      ? `<a class="row-link" href="${d.url}" target="_blank" rel="noopener">보기 ↗</a>`
      : '';
    return `<div class="row" style="--c:${p.color}">
      <div class="row-plat">${p.label}</div>
      <div class="row-body muted">정보 없음</div>${link}</div>`;
  }
  // 별점은 미집계지만 후기수는 있는 경우 (주로 카카오)
  if (d.score == null) {
    const link = d.url
      ? `<a class="row-link" href="${d.url}" target="_blank" rel="noopener">보기 ↗</a>`
      : '';
    return `<div class="row" style="--c:${p.color}">
      <div class="row-plat">${p.label}</div>
      <div class="row-body">
        <div class="no-score">별점 미집계</div>
        <div class="counts">후기 ${fmt(d.reviewCount)}</div>
      </div>${link}</div>`;
  }
  const stars = starBar(d.score);
  const counts = [
    d.scoreCount != null ? `별점 ${fmt(d.scoreCount)}개` : null,
    d.reviewCount != null ? `리뷰 ${fmt(d.reviewCount)}` : null,
    d.blogReviewCount != null ? `블로그 ${fmt(d.blogReviewCount)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const link = d.url
    ? `<a class="row-link" href="${d.url}" target="_blank" rel="noopener">보기 ↗</a>`
    : '';
  return `<div class="row" style="--c:${p.color}">
    <div class="row-plat">${p.label}</div>
    <div class="row-body">
      <div class="score-line"><span class="score">${d.score.toFixed(2)}</span>${stars}</div>
      <div class="counts">${counts || '&nbsp;'}</div>
    </div>${link}</div>`;
}

function starBar(score) {
  const pct = Math.max(0, Math.min(100, (score / 5) * 100));
  return `<span class="stars"><span class="stars-bg">★★★★★</span><span class="stars-fg" style="width:${pct}%">★★★★★</span></span>`;
}

function renderMatchNote(r) {
  const n = r.platforms.naver;
  if (n && n.matchSim != null) {
    el('matchNote').textContent = `네이버·카카오 매칭: 이름 유사도 ${n.matchSim}, 거리 ${n.matchDist}m`;
  }
}

function renderDetailAgg(r) {
  el('detailAgg').innerHTML = r.agg
    ? r.agg.rating != null
      ? `<span class="da-score">${r.agg.rating.toFixed(1)}<span>★</span></span><span class="da-label">종합 평점 · ${r.agg.confidence}개 플랫폼 · 리뷰 ${fmt(r.agg.reviews)}</span>`
      : `<span class="da-label">별점 정보 없음 · 후기 ${fmt(r.agg.reviews)}</span>`
    : '';
}

// 클릭 후 네이버/구글이 보강되면 종합 점수를 프론트에서 다시 계산 (백엔드 score.mjs와 동일 로직)
function computeAgg(r) {
  const P = ['naver', 'kakao', 'diningcode', 'google'];
  const C = 3.9;
  const M = 20;
  let wsum = 0;
  let wadj = 0;
  let reviews = 0;
  let best = 0;
  const used = [];
  for (const p of P) {
    const d = r.platforms[p];
    if (!d) continue;
    reviews += (d.reviewCount || 0) + (d.blogReviewCount || 0);
    if (!(d.score > 0)) continue;
    const n = d.scoreCount || d.reviewCount || 0;
    const adj = (n * d.score + M * C) / (n + M);
    const w = Math.log10(1 + n) || 0.1;
    wsum += w;
    wadj += w * adj;
    best = Math.max(best, d.score);
    used.push(p);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  if (wsum > 0) {
    const rating = wadj / wsum;
    const vb = Math.min(0.3, Math.log10(1 + reviews) / 12);
    const cb = (used.length - 1) * 0.05;
    r.agg = { rating: r2(rating), recommend: r2(rating + vb + cb), reviews, best: r2(best), platforms: used, confidence: used.length };
  } else if (reviews > 0) {
    r.agg = { rating: null, recommend: -1, reviews, best: 0, platforms: [], confidence: 0 };
  } else {
    r.agg = null;
  }
}

// 상세 부가정보: 한줄평 · 대표 메뉴 · 편의시설 (네이버 데이터)
function renderDetailExtras(r) {
  const nv = r.platforms.naver || {};
  const parts = [];
  // 영업 상태 (영업중/영업전/영업종료 + 다음 변화 · 오늘 영업시간)
  const o = openInfo(r);
  if (o) {
    const bits = [o.desc, nv.todayHours ? '영업시간 ' + nv.todayHours : ''].filter(Boolean).join(' · ');
    parts.push(
      `<div class="open-line ${o.cls}"><span class="dot"></span><b>${o.label}</b>${bits ? ` <span class="open-sub">${esc(bits)}</span>` : ''}</div>`,
    );
  }
  // 사진 갤러리 (네이버 사진 + 다이닝코드 사진 + 메뉴 사진, 중복 제거 후 최대 8장)
  const dc = r.platforms.diningcode || {};
  const gallery = [
    ...new Set([
      ...(nv.photos || []),
      ...(dc.images || []),
      ...(nv.menus || []).map((m) => m.image).filter(Boolean),
    ]),
  ].slice(0, 8);
  if (gallery.length) {
    parts.push(
      '<div class="gallery">' +
        gallery
          .map((u) => `<img class="gphoto" src="${esc(u)}" alt="" loading="lazy" onerror="this.remove()">`)
          .join('') +
        '</div>',
    );
  }
  if (nv.microReview) parts.push(`<p class="micro">“${esc(nv.microReview)}”</p>`);
  // 리뷰 스니펫 (네이버 방문자 리뷰 + 다이닝코드 대표 리뷰)
  const reviews = [];
  if (nv.review && nv.review.text)
    reviews.push({ src: '네이버', text: nv.review.text, meta: [nv.review.user, nv.review.date].filter(Boolean).join(' · ') });
  if (dc.review && dc.review.text)
    reviews.push({ src: '다이닝코드', text: dc.review.text, meta: [dc.review.user, dc.review.date].filter(Boolean).join(' · ') });
  if (reviews.length) {
    parts.push(
      '<div class="reviews">' +
        reviews
          .map((rv) => {
            const t = rv.text.length > 150 ? rv.text.slice(0, 150) + '…' : rv.text;
            return `<div class="review"><div class="rv-head"><span class="rv-src">${rv.src}</span>${rv.meta ? `<span class="rv-meta">${esc(rv.meta)}</span>` : ''}</div><p class="rv-text">${esc(t)}</p></div>`;
          })
          .join('') +
        '</div>',
    );
  }
  if (nv.menus && nv.menus.length) {
    parts.push(
      '<div class="menus">' +
        nv.menus
          .map((m) => `<span class="menu">${esc(m.name)}${m.price ? ` <b>${esc(m.price)}</b>` : ''}</span>`)
          .join('') +
        '</div>',
    );
  }
  if (nv.conveniences && nv.conveniences.length) {
    parts.push(
      '<div class="conv">' + nv.conveniences.map((c) => `<span class="tag">${esc(c)}</span>`).join('') + '</div>',
    );
  }
  // 길찾기 · 지도앱으로 열기 (모바일은 앱, 데스크톱은 웹으로 열림)
  if (isFinite(r.lat) && isFinite(r.lng)) {
    const enc = encodeURIComponent(r.name);
    const kakao = `https://map.kakao.com/link/to/${enc},${r.lat},${r.lng}`;
    const naver = `https://map.naver.com/p/search/${enc}`;
    const gmap = `https://www.google.com/maps/dir/?api=1&destination=${r.lat},${r.lng}`;
    parts.push(
      `<div class="dir-row">
        <a class="dir-btn kakao" href="${kakao}" target="_blank" rel="noopener">카카오맵 길찾기</a>
        <a class="dir-btn naver" href="${naver}" target="_blank" rel="noopener">네이버지도</a>
        <a class="dir-btn gmap" href="${gmap}" target="_blank" rel="noopener">구글맵</a>
      </div>`,
    );
  }
  el('detailExtras').innerHTML = parts.join('');
}

el('backBtn').addEventListener('click', () => {
  el('detail').hidden = true;
  el('listSection').hidden = false;
});

// --- 유틸 ---
function fmt(n) {
  return typeof n === 'number' ? n.toLocaleString('ko-KR') : n;
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 정렬 칩
document.querySelectorAll('#sortBar .chip[data-sort]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.sort = btn.dataset.sort;
    document
      .querySelectorAll('#sortBar .chip[data-sort]')
      .forEach((b) => b.classList.toggle('active', b === btn));
    renderList();
  });
});

// 별점·리뷰 최소 기준 필터 칩 (같은 그룹 내 토글, 지도 마커에도 반영)
document.querySelectorAll('#filterBar .fchip').forEach((btn) => {
  btn.addEventListener('click', () => {
    const isRating = btn.dataset.minRating != null;
    const field = isRating ? 'minRating' : 'minReviews';
    const attr = isRating ? 'data-min-rating' : 'data-min-reviews';
    const v = Number(isRating ? btn.dataset.minRating : btn.dataset.minReviews);
    state[field] = state[field] === v ? 0 : v; // 같은 값 다시 누르면 해제
    document
      .querySelectorAll(`#filterBar .fchip[${attr}]`)
      .forEach((b) => b.classList.toggle('active', Number(b.getAttribute(attr)) === state[field]));
    renderList();
    renderMarkers();
  });
});

// AI 지역 브리핑
el('briefBtn').addEventListener('click', async () => {
  const items = visibleRestaurants();
  if (!items.length) return;
  const btn = el('briefBtn');
  const card = el('briefCard');
  btn.disabled = true;
  btn.textContent = '✨ 브리핑 생성 중…';
  card.hidden = false;
  card.className = 'brief-card loading';
  card.textContent = '이 지역 맛집을 살펴보는 중…';
  try {
    const places = items.slice(0, 40).map((r) => ({ name: r.name, category: r.category, agg: r.agg }));
    const res = await fetch('/api/brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ area: '이 지역', places }),
    });
    const data = await res.json();
    card.className = 'brief-card';
    const src = data.source === 'ai' ? '✨ AI 생성' : data.source === 'rule' ? '규칙 기반 요약' : '';
    card.innerHTML = `<p>${esc(data.brief)}</p>${src ? `<div class="brief-src">${src}</div>` : ''}`;
  } catch (_) {
    card.className = 'brief-card';
    card.textContent = '브리핑을 만들지 못했어요.';
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ 이 지역 AI 브리핑';
  }
});

// 즐겨찾기만 보기 토글
el('favToggle').addEventListener('click', () => {
  state.showFavs = !state.showFavs;
  el('favToggle').classList.toggle('active', state.showFavs);
  el('favToggle').textContent = state.showFavs ? '★ 즐겨찾기' : '☆ 즐겨찾기';
  state.catFilter = null;
  renderMarkers();
  renderList();
  if (state.showFavs && state.favorites.size) fitToMarkers();
});

// 헬스체크로 구글 활성 여부 미리 반영
fetch('/api/health')
  .then((r) => r.json())
  .then((h) => (state.googleEnabled = !!h.google))
  .catch(() => {});

// PWA: 서비스워커 등록 (설치·오프라인·빠른 재실행)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch((e) => console.warn('SW:', e.message));
  });
}

// 지도 뷰를 기억(마지막으로 보던 위치)
function saveView() {
  const c = map.getCenter();
  try {
    localStorage.setItem('goodrest:view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
  } catch (_) {}
}
map.on('moveend', saveView);

// "이 지역 맛집 찾기" 버튼 — 화면 영역 전체에서 추천을 불러옴.
// 너무 넓게 줌아웃한 상태면 가운데로 확대한 뒤 검색한다.
el('hereBtn').addEventListener('click', async () => {
  if (map.getZoom() < 12) {
    map.setView(map.getCenter(), 13, { animate: true });
    await new Promise((r) => map.once('moveend', r));
  }
  nearbyArea(map.getBounds());
});
L.DomEvent.disableClickPropagation(el('hereBtn'));

// 저장된 즐겨찾기 로드
state.favorites = loadFavs();

// 시작 시: 마지막으로 보던 위치(없으면 강남역)의 추천을 검색 없이 자동 표시
(function initHome() {
  let v = null;
  try {
    v = JSON.parse(localStorage.getItem('goodrest:view'));
  } catch (_) {}
  if (v && isFinite(v.lat) && isFinite(v.lng)) {
    map.setView([v.lat, v.lng], v.zoom || 14);
  }
  // 첫 로드는 중심 주변 좁은 영역(~2.6km)만 빠르게. 전체는 '이 지역 맛집 찾기'로 확장.
  const c = map.getCenter();
  const d = 0.012;
  nearbyArea(L.latLngBounds([c.lat - d, c.lng - d], [c.lat + d, c.lng + d]));
})();
