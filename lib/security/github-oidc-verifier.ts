type GitHubOidcClaims = {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  repository?: string;
  ref?: string;
  workflow_ref?: string;
};

type GitHubJwk = {
  kid?: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
};

let jwksCache: { expiresAt: number; keys: GitHubJwk[] } | null = null;

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function parseJson<T>(value: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(value)) as T;
}

async function getGitHubSigningKey(kid: string): Promise<GitHubJwk | null> {
  const now = Date.now();
  if (!jwksCache || jwksCache.expiresAt <= now) {
    const response = await fetch(
      "https://token.actions.githubusercontent.com/.well-known/jwks",
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { keys?: GitHubJwk[] };
    jwksCache = {
      expiresAt: now + 10 * 60_000,
      keys: body.keys ?? [],
    };
  }
  return jwksCache.keys.find((key) => key.kid === kid) ?? null;
}

export async function verifyGitHubOidcToken(
  token: string,
  expectedWorkflowRef?: string,
): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;

    const header = parseJson<{ alg?: string; kid?: string }>(
      base64UrlDecode(parts[0]),
    );
    if (header.alg !== "RS256" || !header.kid) return false;

    const claims = parseJson<GitHubOidcClaims>(base64UrlDecode(parts[1]));
    const now = Math.floor(Date.now() / 1000);

    if (claims.iss !== "https://token.actions.githubusercontent.com") return false;
    if (
      !(
        claims.aud === "https://tracer-pied-alpha.vercel.app" ||
        (Array.isArray(claims.aud) &&
          claims.aud.includes("https://tracer-pied-alpha.vercel.app"))
      )
    ) return false;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 30)) return false;
    if (claims.repository !== "shunai394-hash/tracer") return false;
    if (claims.ref !== "refs/heads/main") return false;
    if (expectedWorkflowRef && claims.workflow_ref !== expectedWorkflowRef) {
      return false;
    }
    if (
      claims.workflow_ref &&
      !claims.workflow_ref.startsWith(
        "shunai394-hash/tracer/.github/workflows/",
      )
    ) return false;

    const jwk = await getGitHubSigningKey(header.kid);
    if (!jwk) return false;

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureBytes = base64UrlDecode(parts[2]);
    const signatureBuffer = new ArrayBuffer(signatureBytes.byteLength);
    new Uint8Array(signatureBuffer).set(signatureBytes);

    return crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}
