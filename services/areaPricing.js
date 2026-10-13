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
    return {
      pickupZone: null,
      dropoffZone: null,
      pickupZones: [],
      dropoffZones: [],
      commonZones: [],
      sameZone: null,
    };
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
      "intraEnabled",
      "intraOrdinaryPricePerKm",
      "intraSuperPricePerKm",
      "intraMinimumFare",
    ],
    ...(transaction ? { transaction } : {}),
    raw: true,
  });

  const pickupZones = matchZones(pickupPoint, zones);
  const dropoffZones = matchZones(dropoffPoint, zones);
  const pickupZone = pickupZones[0] || null;
  const dropoffZone = dropoffZones[0] || null;
  const dropoffZoneIds = new Set(dropoffZones.map((zone) => Number(zone.id)));
  const commonZones = pickupZones.filter((zone) =>
    dropoffZoneIds.has(Number(zone.id))
  );
  const sameZone = commonZones[0] || null;

  return {
    pickupZone,
    dropoffZone,
    pickupZones,
    dropoffZones,
    commonZones,
    sameZone,
  };
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

// سعر الكيلو للرحلة داخل الزون، أو null إذا التسعيرة الداخلية مطفية/ناقصة
function intraPricePerKm(zone, serviceType) {
  if (!zone) return null;
  const enabled = zone.intraEnabled === true || zone.intraEnabled === 1 || zone.intraEnabled === "1";
  if (!enabled) return null;
  const value =
    normalizeServiceType(serviceType) === "super"
      ? zone.intraSuperPricePerKm ?? zone.intraOrdinaryPricePerKm
      : zone.intraOrdinaryPricePerKm;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// أصغر زون يحتوي الانطلاق والوصول سوية وإله تسعيرة داخلية مفعّلة
function findIntraZone(pickupZones, dropoffZones, serviceType) {
  const dropoffIds = new Set((dropoffZones || []).map((zone) => Number(zone.id)));
  // pickupZones مرتبة من الأصغر للأكبر
  for (const zone of pickupZones || []) {
    if (!dropoffIds.has(Number(zone.id))) continue;
    const perKm = intraPricePerKm(zone, serviceType);
    if (perKm != null) return { zone, perKm };
  }
  return null;
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
    // الترتيب بالـ id (ترتيب الحفظ الحقيقي) مو بـ createdAt: الأخير محفوظ
    // لحد الثانية بس، فإذا انحفظ سعرين بنفس الثانية جان ممكن يرجع القديم
    const pricing = await PricingSetting.findOne({
      where,
      order: [["id", "DESC"]],
      ...options,
    });
    if (pricing) return pricing;
  }
  return null;
}

async function calculateFare({ pickup, dropoff, distanceKm, durationMin, serviceType, transaction }) {
  const normalizedService = normalizeServiceType(serviceType);
  const {
    pickupZone,
    dropoffZone,
    pickupZones,
    dropoffZones,
    commonZones,
  } =
    await resolveTripPricingZones(pickup, dropoff, transaction);
  // ترتيب القواعد:
  // 1) ربط بين زون الانطلاق وزون الوصول (إذا مو نفس أصغر زون).
  //    "نفس الزون" = أصغر زون يحتوي الانطلاق هو نفسه أصغر زون يحتوي الوصول.
  // 2) غير هيج: أصغر زون يحتوي النقطتين وإله تسعيرة داخلية مفعّلة.
  // 3) غير هيج: السعر العام.
  const pickupBest = (pickupZones || [])[0];
  const dropoffBest = (dropoffZones || [])[0];
  const sameSmallestZone =
    pickupBest && dropoffBest && Number(pickupBest.id) === Number(dropoffBest.id);
  const routeMatch = sameSmallestZone
    ? { routePrice: null, pickupZone: null, dropoffZone: null }
    : await findBestZoneRoutePrice(pickupZones, dropoffZones, transaction);
  const routePrice = routeMatch.routePrice;
  const areaType = "mixed";
  const pricing = await findPricingSetting(normalizedService, areaType, transaction);
  const routePerKm = routePricePerKm(routePrice, normalizedService);
  const intraMatch =
    routePerKm == null ? findIntraZone(pickupZones, dropoffZones, normalizedService) : null;
  const intraMinimum = intraMatch ? parseFloat(intraMatch.zone.intraMinimumFare) : NaN;

  const parsedDistance = Number(distanceKm);
  const parsedDuration = Number(durationMin);
  const dKm = Number.isFinite(parsedDistance) && parsedDistance > 0 ? parsedDistance : null;
  const dur = Number.isFinite(parsedDuration) && parsedDuration >= 0 ? parsedDuration : null;
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
    const generalMinimum = Number.isFinite(parseFloat(pricing?.minimumFare))
      ? parseFloat(pricing.minimumFare)
      : DEFAULT_PRICING.minimumFare;
    // الرحلة الداخلية قصيرة: إلها حد أدنى خاص إذا الأدمن حدده
    const minimum = Number.isFinite(intraMinimum) && intraMinimum > 0
      ? Math.max(generalMinimum, intraMinimum)
      : generalMinimum;

    const appliedPerKm = routePerKm ?? intraMatch?.perKm ?? perKm;
    const beforeMin = base + dKm * appliedPerKm + (dur != null ? dur * perMin : 0);
    // التقريب لأقرب 250، بس ما ينزل تحت الحد الأدنى (نقرّب الحد الأدنى للأعلى)
    let rounded = Math.round(Math.max(minimum, beforeMin) / 250) * 250;
    if (rounded < minimum) rounded = Math.ceil(minimum / 250) * 250;
    estimatedFare = String(rounded);
  }

  return {
    areaType,
    pricing,
    pricingZone: intraMatch
      ? {
          id: intraMatch.zone.id,
          name: intraMatch.zone.name,
          pricePerKm: intraMatch.perKm,
          minimumFare: Number.isFinite(intraMinimum) && intraMinimum > 0 ? intraMinimum : null,
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
    pickupZone: (routeMatch.pickupZone || pickupZone)
      ? {
          id: (routeMatch.pickupZone || pickupZone).id,
          name: (routeMatch.pickupZone || pickupZone).name,
        }
      : null,
    dropoffZone: (routeMatch.dropoffZone || dropoffZone)
      ? {
          id: (routeMatch.dropoffZone || dropoffZone).id,
          name: (routeMatch.dropoffZone || dropoffZone).name,
        }
      : null,
    pricingSource: routePerKm != null
      ? "zone_route"
      : intraMatch
        ? "zone_internal"
        : "general",
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
