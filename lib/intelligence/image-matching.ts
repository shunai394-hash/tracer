export type ImageMatchResult = {
  attempted: boolean;
  similar: boolean | null;
  note: string;
};

/**
 * Image similarity is supporting evidence only.
 * Identity confirmation stays in identity-confidence.ts.
 */
export function evaluateImageMatch(args: {
  sourceImageUrl: string | null;
  candidateImageUrl: string | null;
}): ImageMatchResult {
  if (!args.sourceImageUrl || !args.candidateImageUrl) {
    return {
      attempted: false,
      similar: null,
      note: "image_not_observed",
    };
  }

  const same = args.sourceImageUrl === args.candidateImageUrl;
  return {
    attempted: true,
    similar: same ? true : null,
    note: same
      ? "exact_image_url_match_not_identity_confirmation"
      : "feature_embedding_not_available_identity_text_prevails",
  };
}

export function verifyImageMatchInvariants(): {
  ok: boolean;
  cases: Array<{ name: string; expected: boolean; actual: boolean }>;
} {
  const missing = evaluateImageMatch({
    sourceImageUrl: null,
    candidateImageUrl: "https://example.com/a.jpg",
  });
  const cases = [
    {
      name: "missing_image_is_not_run",
      expected: true,
      actual: missing.attempted === false && missing.similar === null,
    },
  ];
  return {
    ok: cases.every((item) => item.actual === item.expected),
    cases,
  };
}
