import { EMPTY_IDENTIFIERS, matchProductIdentity, type ProductIdentifiers } from "./identifiers.ts";

export type CompetitorIdentityEvidence = ProductIdentifiers & {
  brand?: string | null;
  title?: string | null;
};

export type CompetitorIdentityLink = {
  linked: boolean;
  method: string;
  confidence: number;
  rationale: string;
  matchedSupplyProductId: string | null;
};

/**
 * Link a competitor offer to exactly one supply product only when identifier
 * evidence confirms identity. Titles and images are diagnostic evidence only.
 * If two supply products share the same matching identifier, fail closed.
 */
export function linkCompetitorOfferToSupply(args: {
  competitor: CompetitorIdentityEvidence;
  supplies: Array<{ productId: string; identity: CompetitorIdentityEvidence }>;
}): CompetitorIdentityLink {
  const eligible = args.supplies
    .map((supply) => ({
      productId: supply.productId,
      match: matchProductIdentity({
        market: { ...EMPTY_IDENTIFIERS, ...args.competitor },
        supply: { ...EMPTY_IDENTIFIERS, ...supply.identity },
      }),
    }))
    .filter((item) => item.match.linked && item.match.salesEligible);

  if (eligible.length === 1) {
    const item = eligible[0];
    return {
      linked: true,
      method: item.match.method,
      confidence: item.match.confidence,
      rationale: item.match.rationale,
      matchedSupplyProductId: item.productId,
    };
  }

  if (eligible.length > 1) {
    return {
      linked: false,
      method: "ambiguous",
      confidence: 0,
      rationale: "identifier matches multiple supply products; manual resolution required",
      matchedSupplyProductId: null,
    };
  }

  const diagnostic = args.supplies
    .map((supply) => matchProductIdentity({
      market: { ...EMPTY_IDENTIFIERS, ...args.competitor },
      supply: { ...EMPTY_IDENTIFIERS, ...supply.identity },
    }))
    .find((match) => match.method !== "none");

  return {
    linked: false,
    method: diagnostic?.method ?? "none",
    confidence: diagnostic?.confidence ?? 0,
    rationale: diagnostic?.rationale ?? "no identifier overlap",
    matchedSupplyProductId: null,
  };
}

export function verifyCompetitorIdentityLinkInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const jan = "4573138107287";
  const cases = [
    {
      name: "exact_identifier_links_one_supply",
      expected: true,
      actual: linkCompetitorOfferToSupply({
        competitor: { ...EMPTY_IDENTIFIERS, jan },
        supplies: [{ productId: "supply-1", identity: { ...EMPTY_IDENTIFIERS, gtin: jan } }],
      }).matchedSupplyProductId === "supply-1",
    },
    {
      name: "title_only_never_links",
      expected: true,
      actual: !linkCompetitorOfferToSupply({
        competitor: { ...EMPTY_IDENTIFIERS, title: "same title" },
        supplies: [{ productId: "supply-1", identity: { ...EMPTY_IDENTIFIERS, title: "same title" } }],
      }).linked,
    },
    {
      name: "ambiguous_identifier_never_links",
      expected: true,
      actual: !linkCompetitorOfferToSupply({
        competitor: { ...EMPTY_IDENTIFIERS, jan },
        supplies: [
          { productId: "supply-1", identity: { ...EMPTY_IDENTIFIERS, jan } },
          { productId: "supply-2", identity: { ...EMPTY_IDENTIFIERS, gtin: jan } },
        ],
      }).linked,
    },
    {
      name: "different_identifiers_never_link",
      expected: true,
      actual: !linkCompetitorOfferToSupply({
        competitor: { ...EMPTY_IDENTIFIERS, jan },
        supplies: [{ productId: "supply-1", identity: { ...EMPTY_IDENTIFIERS, gtin: "4006381333931" } }],
      }).linked,
    },
  ];
  return { ok: cases.every((item) => item.actual === item.expected), cases };
}
