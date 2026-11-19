export function inputNumberFormat({ step, min, significantDigits } = {}) {
  if (significantDigits || step === "any") {
    return {
      useGrouping: false,
      maximumSignificantDigits: significantDigits || 9,
    };
  }
  const decimalPlaces = (value) => {
    const n = Math.abs(Number(value));
    return n > 0 && n < 1 ? Math.ceil(-Math.log10(n)) : 0;
  };
  return {
    useGrouping: false,
    maximumFractionDigits: Math.min(
      12,
      Math.max(3, decimalPlaces(step), decimalPlaces(min)),
    ),
  };
}

export function conciseNumber(value, significantDigits = 6) {
  return value !== "" && value != null && Number.isFinite(Number(value))
    ? Number(value).toLocaleString(undefined, {
        useGrouping: false,
        maximumSignificantDigits: significantDigits,
      })
    : "—";
}

export function displayAngle(radians, unit) {
  return unit === "deg" ? radians * (180 / Math.PI) : radians;
}
