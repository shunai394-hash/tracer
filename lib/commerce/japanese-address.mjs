/** Split a Japanese street address into the municipality required by CJ and the remaining street line. */
export function splitJapaneseAddress(value, prefecture = "") {
  let address = String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  const pref = String(prefecture ?? "").normalize("NFKC").trim();
  if (!address) return { city: "", address1: "" };
  if (pref && address.startsWith(pref)) address = address.slice(pref.length).trim();

  const patterns = [
    /^(.+?市.+?区)(.+)$/,
    /^(.+?郡.+?[町村])(.+)$/,
    /^(.+?[市区町村])(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = address.match(pattern);
    if (match?.[1]?.trim() && match?.[2]?.trim()) {
      return { city: match[1].trim(), address1: match[2].trim() };
    }
  }

  // Do not invent a city when the address cannot be parsed. Procurement preflight
  // will keep the paid order pending until the address can be repaired.
  return { city: "", address1: address };
}
