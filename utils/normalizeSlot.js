export function normalizeSlotString(s) {
  return String(s || "")
    .replace(/[\u2013\u2014]/g, "-") // convert unicode dash to ASCII dash
    .replace(/-/g, " - ")
    .replace(/\s+-\s+/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}
