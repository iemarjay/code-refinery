const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "code-refinery";
const API_VERSION = "2022-11-28";

function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, "\n");

  if (normalized.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "PKCS#1 key detected (BEGIN RSA PRIVATE KEY). " +
        "Convert to PKCS#8: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem",
    );
  }

  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");

  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

export async function generateAppJwt(
  appId: string,
  pem: string,
): Promise<string> {
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );

  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
    ),
  );

  const signingInput = new TextEncoder().encode(`${header}.${payload}`);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      pemToArrayBuffer(pem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch (err) {
    throw new Error(
      `Failed to import private key. Ensure GITHUB_PRIVATE_KEY is in PKCS#8 format. ` +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    signingInput,
  );

  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}

export async function getInstallationToken(
  appId: string,
  pem: string,
  installationId: number,
): Promise<string> {
  const jwt = await generateAppJwt(appId, pem);

  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": API_VERSION,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to get installation token (HTTP ${response.status}): ${body}`,
    );
  }

  const data: { token: string } = await response.json();
  return data.token;
}
