const ARABIC_INDIC_ZERO = "٠".charCodeAt(0);
const EASTERN_ARABIC_ZERO = "۰".charCodeAt(0);

function toLatinDigits(value = "") {
  return String(value).replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      return String(code - ARABIC_INDIC_ZERO);
    }
    return String(code - EASTERN_ARABIC_ZERO);
  });
}

function phoneDigits(value = "") {
  return toLatinDigits(value).replace(/\D/g, "");
}

function normalizePhone(value = "") {
  let digits = phoneDigits(value);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("9640")) digits = `964${digits.slice(4)}`;
  if (digits.startsWith("0")) digits = `964${digits.slice(1)}`;
  if (/^7\d{9}$/.test(digits)) digits = `964${digits}`;

  return /^9647\d{9}$/.test(digits) ? digits : "";
}

function phoneVariants(value = "") {
  const normalized = normalizePhone(value);
  if (!normalized) return [];

  const subscriber = normalized.slice(3);
  return [...new Set([
    normalized,
    `+${normalized}`,
    `0${subscriber}`,
    subscriber,
  ])];
}

function toDialPhone(value = "") {
  const normalized = normalizePhone(value);
  return normalized ? `+${normalized}` : "";
}

module.exports = {
  normalizePhone,
  phoneDigits,
  phoneVariants,
  toDialPhone,
  toLatinDigits,
};
