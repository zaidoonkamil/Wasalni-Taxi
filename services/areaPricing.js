const { AreaPricingZone, AreaZoneRoutePrice, PricingSetting } = require("../models");

const AREA_TYPES = ["rich", "poor", "mixed"];
const SERVICE_TYPES = ["ordinary", "super"];

const DEFAULT_PRICING = {
  baseFare: 2000,
  pricePerKm: 500,
  pricePerMinute: 0,
  minimumFare: 3000,
};

const normalizeAreaType = (value) => (AREA_TYPES.includes(value) ? value : "mixed");
const normalizeServiceType = (value) => (SERVICE_TYPES.includes(value) ? value : "ordinary");

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((Number(lat2) - Number(lat1)) * Math.PI) / 180;
  const dLng = ((Number(lng2) - Number(lng1)) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((Number(lat1) * Math.PI) / 180) *
      Math.cos((Number(lat2) * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parsePoint(point) {
  const lat = Number(point?.lat ?? point?.latitude);
  const lng = Number(point?.lng ?? point?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function matchZone(point, zones) {
  if (!point) return null;

  return matchZones(point, zones)[0] || null;
}

function matchZones(point, zones) {
  if (!point) return [];

  const matched = [];
  for (const zone of zones) {
    const distance = haversineMeters(point.lat, point.lng, zone.centerLat, zone.centerLng);
    const radius = Number(zone.radiusMeters || 0);
    if (radius <= 0 || distance > radius) continue;
    matched.push({ zone, distance, radius });
  }

  matched.sort((a, b) => {
    const radiusDiff = a.radius - b.radius;
    if (radiusDiff !== 0) return radiusDiff;
    return a.distance - b.distance;
  });

  return matched.map((item) => item.zone);
}

async function resolveTripPricingZones(pickup, dropoff, transaction) {
  const pickupPoint = parsePoint(pickup);
  const dropoffPoint = parsePoint(dropoff);
  if (!pickupPoint || !dropoffPoint) {
    return { pickupZone: null, dropoffZone: null, sameZone: null };
  }

  const zones = await AreaPricingZone.findAll({
    where: { active: true },
    attributes: [
      "id",
      "name",
      "centerLat",
      "centerLng",
      "radiusMeters",
      "ordinaryPricePerKm",
      "superPricePerKm",
    ],
    ...(transaction ? { transaction } : {}),
    raw: true,
  });

  const pickupZones = matchZones(pickupPoint, zones);
  const dropoffZones = matchZones(dropoffPoint, zones);
  const pickupZone = pickupZones[0] || null;
  const dropoffZone = dropoffZones[0] || null;
  const sameZone =
    pickupZone && dropoffZone && Number(pickupZone.id) === Number(dropoffZone.id)
      ? pickupZone
      : null;

  return { pickupZone, dropoffZone, pickupZones, dropoffZones, sameZone };
}

async function resolveTripPricingZone(pickup, dropoff, transaction) {
  const { sameZone } = await resolveTripPricingZones(pickup, dropoff, transaction);
  return sameZone;
}

async function resolveTripAreaType() {
  return "mixed";
}

function zonePricePerKm(zone, serviceType) {
  if (!zone) return null;
  const value =
    normalizeServiceType(serviceType) === "super"
      ? zone.superPricePerKm ?? zone.ordinaryPricePerKm
      : zone.ordinaryPricePerKm;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function routePricePerKm(routePrice, serviceType) {
  if (!routePrice) return null;
  const value =
    normalizeServiceType(serviceType) === "super"
      ? routePrice.superPricePerKm ?? routePrice.ordinaryPricePerKm
      : routePrice.ordinaryPricePerKm;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRouteZoneIds(fromZoneId, toZoneId) {
  const a = Number(fromZoneId);
  const b = Number(toZoneId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    return null;
  }
  return a < b ? { fromZoneId: a, toZoneId: b } : { fromZoneId: b, toZoneId: a };
}

async function findZoneRoutePrice(pickupZone, dropoffZone, transaction) {
  const ids = normalizeRouteZoneIds(pickupZone?.id, dropoffZone?.id);
  if (!ids) return null;

  return AreaZoneRoutePrice.findOne({
    where: { ...ids, active: true },
    ...(transaction ? { transaction } : {}),
    raw: true,
  });
}

async function findBestZoneRoutePrice(pickupZones, dropoffZones, transaction) {
  const pairs = [];
  const seen = new Set();

  for (const pickupZone of pickupZones || []) {
    for (const dropoffZone of dropoffZones || []) {
      const ids = normalizeRouteZoneIds(pickupZone?.id, dropoffZone?.id);
      if (!ids) continue;

      const key = `${ids.fromZoneId}:${ids.toZoneId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ ...ids, pickupZone, dropoffZone });
    }
  }

  for (const pair of pairs) {
    const routePrice = await AreaZoneRoutePrice.findOne({
      where: {
        fromZoneId: pair.fromZoneId,
        toZoneId: pair.toZoneId,
        active: true,
      },
      ...(transaction ? { transaction } : {}),
      raw: true,
    });

    if (routePrice) {
      return {
        routePrice,
        pickupZone: pair.pickupZone,
        dropoffZone: pair.dropoffZone,
      };
    }
  }

  return { routePrice: null, pickupZone: null, dropoffZone: null };
}

async function findPricingSetting(serviceType, areaType, transaction) {
  const normalizedService = normalizeServiceType(serviceType);
  const normalizedArea = normalizeAreaType(areaType);
  const options = transaction ? { transaction } : {};

  const candidates = [
    { serviceType: normalizedService, areaType: normalizedArea },
    { serviceType: normalizedService, areaType: "mixed" },
  ];
  if (normalizedService === "super") {
    candidates.push(
      { serviceType: "ordinary", areaType: normalizedArea },
      { serviceType: "ordinary", areaType: "mixed" }
    );
  }

  for (const where of candidates) {
    const pricing = await PricingSetting.findOne({
      where,
      order: [["createdAt", "DESC"]],
      ...options,
    });
    if (pricing) return pricing;
  }
  return null;
}

async function calculateFare({ pickup, dropoff, distanceKm, durationMin, serviceType, transaction }) {
  const normalizedService = normalizeServiceType(serviceType);
  const { pickupZone, dropoffZone, pickupZones, dropoffZones, sameZone } =
    await resolveTripPricingZones(pickup, dropoff, transaction);
  const routeMatch = await findBestZoneRoutePrice(pickupZones, dropoffZones, transaction);
  const routePrice = routeMatch.routePrice;
  const areaType = "mixed";
  const pricing = await findPricingSetting(normalizedService, areaType, transaction);
  const routePerKm = routePricePerKm(routePrice, normalizedService);
  const zonePerKm = routePerKm == null ? zonePricePerKm(sameZone, normalizedService) : null;

  const dKm = Number.isFinite(Number(distanceKm)) ? Number(distanceKm) : null;
  const dur = Number.isFinite(Number(durationMin)) ? Number(durationMin) : null;
  let estimatedFare = null;

  if (dKm != null) {
    const base = Number.isFinite(parseFloat(pricing?.baseFare))
      ? parseFloat(pricing.baseFare)
      : DEFAULT_PRICING.baseFare;
    const perKm = Number.isFinite(parseFloat(pricing?.pricePerKm))
      ? parseFloat(pricing.pricePerKm)
      : DEFAULT_PRICING.pricePerKm;
    const perMin = Number.isFinite(parseFloat(pricing?.pricePerMinute))
      ? parseFloat(pricing.pricePerMinute)
      : DEFAULT_PRICING.pricePerMinute;
    const minimum = Number.isFinite(parseFloat(pricing?.minimumFare))
      ? parseFloat(pricing.minimumFare)
      : DEFAULT_PRICING.minimumFare;

    const beforeMin = base + dKm * (routePerKm ?? zonePerKm ?? perKm) + (dur != null ? dur * perMin : 0);
    estimatedFare = String(Math.round(Math.max(minimum, beforeMin) / 250) * 250);
  }

  return {
    areaType,
    pricing,
    pricingZone: sameZone && zonePerKm != null
      ? {
          id: sameZone.id,
          name: sameZone.name,
          pricePerKm: zonePerKm,
        }
      : null,
    pricingRoute: routePrice && routePerKm != null
      ? {
          id: routePrice.id,
          fromZoneId: routePrice.fromZoneId,
          toZoneId: routePrice.toZoneId,
          pricePerKm: routePerKm,
        }
      : null,
    pickupZone: routeMatch.pickupZone
      ? { id: routeMatch.pickupZone.id, name: routeMatch.pickupZone.name }
      : pickupZone
        ? { id: pickupZone.id, name: pickupZone.name }
        : null,
    dropoffZone: routeMatch.dropoffZone
      ? { id: routeMatch.dropoffZone.id, name: routeMatch.dropoffZone.name }
      : dropoffZone
        ? { id: dropoffZone.id, name: dropoffZone.name }
        : null,
    matchedPickupZones: (pickupZones || []).map((zone) => ({ id: zone.id, name: zone.name })),
    matchedDropoffZones: (dropoffZones || []).map((zone) => ({ id: zone.id, name: zone.name })),
    estimatedFare,
  };
}

module.exports = {
  AREA_TYPES,
  SERVICE_TYPES,
  DEFAULT_PRICING,
  normalizeAreaType,
  normalizeServiceType,
  resolveTripAreaType,
  resolveTripPricingZone,
  resolveTripPricingZones,
  findPricingSetting,
  findZoneRoutePrice,
  findBestZoneRoutePrice,
  normalizeRouteZoneIds,
  calculateFare,
};
