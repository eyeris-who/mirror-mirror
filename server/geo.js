// Geocoding helpers. Both services are free and need no API key.

function labelOf(name, admin1, country) {
  return [name, admin1, country].filter(Boolean).join(", ");
}

/** City search → candidate locations. Uses Open-Meteo's geocoding API. */
export async function search(query) {
  const q = query.trim();
  if (q.length < 2) return [];

  const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
  u.searchParams.set("name", q);
  u.searchParams.set("count", "8");
  u.searchParams.set("language", "en");
  u.searchParams.set("format", "json");

  const res = await fetch(u);
  if (!res.ok) throw new Error(`geocoding ${res.status}`);
  const { results = [] } = await res.json();

  return results.map((r) => ({
    name: r.name,
    admin1: r.admin1 ?? "",
    country: r.country ?? "",
    countryCode: r.country_code ?? "",
    latitude: r.latitude,
    longitude: r.longitude,
    label: labelOf(r.name, r.admin1, r.country),
  }));
}

/** Coordinates → nearest city / region. Uses BigDataCloud's keyless endpoint. */
export async function reverse(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error("bad coordinates");
  }

  const u = new URL("https://api.bigdatacloud.net/data/reverse-geocode-client");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("localityLanguage", "en");

  const res = await fetch(u);
  if (!res.ok) throw new Error(`reverse geocoding ${res.status}`);
  const d = await res.json();

  const name =
    d.city || d.locality || d.principalSubdivision || "Current location";
  return {
    name,
    admin1: d.principalSubdivision ?? "",
    country: d.countryName ?? "",
    countryCode: d.countryCode ?? "",
    latitude: Number(lat),
    longitude: Number(lon),
    label: labelOf(name, d.principalSubdivision, d.countryName),
  };
}
