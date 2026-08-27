const { AreaPricingZone, PricingSetting } = require("../models");

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

  let selected = null;
  for (const zone of zones) {
    const distance = haversineMeters(point.lat, point.lng, zone.centerLat, zone.centerLng);
    const radius = Number(zone.radiusMeters || 0);
    if (radius <= 0 || distance > radius) continue;
    if (!selected || distance < selected.distance) {
      selected = { zone, distance };
    }
  }
  return selected?.zone || null;
}

async function resolveTripPricingZone(pickup, dropoff, transaction) {
  const pickupPoint = parsePoint(pickup);
  const dropoffPoint = parsePoint(dropoff);
  if (!pickupPoint || !dropoffPoint) return null;

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

  const pickupZone = matchZone(pickupPoint, zones);
  const dropoffZone = matchZone(dropoffPoint, zones);

  if (pickupZone && dropoffZone && Number(pickupZone.id) === Number(dropoffZone.id)) {
    return pickupZone;
  }
  return null;
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
  const pricingZone = await resolveTripPricingZone(pickup, dropoff, transaction);
  const areaType = "mixed";
  const pricing = await findPricingSetting(normalizedService, areaType, transaction);
  const zonePerKm = zonePricePerKm(pricingZone, normalizedService);

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

    const beforeMin = base + dKm * (zonePerKm ?? perKm) + (dur != null ? dur * perMin : 0);
    estimatedFare = String(Math.round(Math.max(minimum, beforeMin) / 250) * 250);
  }

  return {
    areaType,
    pricing,
    pricingZone: pricingZone && zonePerKm != null
      ? {
          id: pricingZone.id,
          name: pricingZone.name,
          pricePerKm: zonePerKm,
        }
      : null,
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
  findPricingSetting,
  calculateFare,
};
