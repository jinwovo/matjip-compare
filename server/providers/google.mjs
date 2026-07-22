// Google Places API (공식). GOOGLE_MAPS_API_KEY 환경변수가 있을 때만 동작.
// rating / userRatingCount 필드는 Enterprise SKU라 과금 대상 — 캐싱으로 호출을 최소화한다.
export function hasGoogleKey() {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

export async function googleRating(name, lat, lng, { signal } = {}) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;

  const body = {
    textQuery: name,
    languageCode: 'ko',
    maxResultCount: 1,
  };
  if (isFinite(lat) && isFinite(lng)) {
    body.locationBias = {
      circle: { center: { latitude: lat, longitude: lng }, radius: 500.0 },
    };
  }

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'places.displayName,places.rating,places.userRatingCount,places.googleMapsUri,places.location',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`google places ${res.status}`);
  const json = await res.json();
  const p = json.places?.[0];
  if (!p) return null;

  return {
    platform: 'google',
    name: p.displayName?.text ?? name,
    score: typeof p.rating === 'number' ? p.rating : null, // 별점 (5점 만점)
    scoreCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
    reviewCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
    url:
      p.googleMapsUri ||
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`,
  };
}
