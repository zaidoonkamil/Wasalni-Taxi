const axios = require("axios");

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

function parsePoint(point) {
  const lat = Number(point?.lat ?? point?.latitude);
  const lng = Number(point?.lng ?? point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };
}

function haversineKm(origin, destination) {
  const radiusKm = 6371;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(destination.lat - origin.lat);
  const dLng = toRad(destination.lng - origin.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(origin.lat)) *
      Math.cos(toRad(destination.lat)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
}

function cacheKey(origin, destination) {
  return `${origin.lat},${origin.lng}:${destination.lat},${destination.lng}`;
}

function readCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  cache.set(key, { createdAt: Date.now(), value });
  if (cache.size > 1000) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function parseDurationSeconds(value) {
  const match = String(value || "").match(/^([0-9]+(?:\.[0-9]+)?)s$/);
  return match ? Number(match[1]) : null;
}

async function resolveRouteMetrics(pickup, dropoff) {
  const origin = parsePoint(pickup);
  const destination = parsePoint(dropoff);
  if (!origin || !destination) {
    const error = new Error("invalid_route_coordinates");
    error.code = "INVALID_ROUTE_COORDINATES";
    throw error;
  }

  const key = cacheKey(origin, destination);
  const cached = readCache(key);
  if (cached) return cached;

  const apiKey =
    process.env.GOOGLE_ROUTES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  const routesApiEnabled =
    String(process.env.GOOGLE_ROUTES_API_ENABLED || "").toLowerCase() ===
    "true";

  if (apiKey) {
    if (routesApiEnabled) try {
      const response = await axios.post(
        ROUTES_URL,
        {
          origin: {
            location: {
              latLng: { latitude: origin.lat, longitude: origin.lng },
            },
          },
          destination: {
            location: {
              latLng: {
                latitude: destination.lat,
                longitude: destination.lng,
              },
            },
          },
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_UNAWARE",
          computeAlternativeRoutes: false,
          languageCode: "ar",
          units: "METRIC",
        },
        {
          timeout: 8000,
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
          },
        }
      );

      const route = response.data?.routes?.[0];
      const distanceMeters = Number(route?.distanceMeters);
      const durationSeconds = parseDurationSeconds(route?.duration);
      if (Number.isFinite(distanceMeters) && distanceMeters > 0) {
        const value = {
          distanceKm: Number((distanceMeters / 1000).toFixed(3)),
          durationMin:
            Number.isFinite(durationSeconds) && durationSeconds >= 0
              ? Math.ceil(durationSeconds / 60)
              : null,
          source: "google_routes",
        };
        writeCache(key, value);
        return value;
      }
    } catch (error) {
      console.error(
        "Google Routes distance error:",
        error.response?.data?.error?.message || error.message
      );
    }

    try {
      const response = await axios.get(DIRECTIONS_URL, {
        timeout: 8000,
        params: {
          origin: `${origin.lat},${origin.lng}`,
          destination: `${destination.lat},${destination.lng}`,
          mode: "driving",
          alternatives: false,
          language: "ar",
          key: apiKey,
        },
      });

      const route = response.data?.routes?.[0];
      const legs = Array.isArray(route?.legs) ? route.legs : [];
      const distanceMeters = legs.reduce(
        (sum, leg) => sum + Number(leg?.distance?.value || 0),
        0
      );
      const durationSeconds = legs.reduce(
        (sum, leg) => sum + Number(leg?.duration?.value || 0),
        0
      );

      if (distanceMeters > 0) {
        const value = {
          distanceKm: Number((distanceMeters / 1000).toFixed(3)),
          durationMin:
            durationSeconds > 0 ? Math.ceil(durationSeconds / 60) : null,
          source: "google_directions",
        };
        writeCache(key, value);
        return value;
      }

      if (response.data?.status && response.data.status !== "OK") {
        console.error(
          "Google Directions distance error:",
          response.data.error_message || response.data.status
        );
      }
    } catch (error) {
      console.error(
        "Google Directions distance error:",
        error.response?.data?.error_message || error.message
      );
    }
  }

  const straightDistanceKm = haversineKm(origin, destination);
  const value = {
    distanceKm: Number(straightDistanceKm.toFixed(3)),
    durationMin: null,
    source: "server_haversine",
  };
  writeCache(key, value);
  return value;
}

module.exports = { resolveRouteMetrics };
