import * as https from "https";
import * as http from "http";

const TOKEN_EXCHANGE_URL =
  "https://code-refinery.emarjay921.workers.dev/token-exchange";

// ---------------------------------------------------------------------------
// OIDC token retrieval (GitHub Actions built-in)
// ---------------------------------------------------------------------------

async function getOidcToken(audience: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      "OIDC token request env vars not found. " +
        "Add `id-token: write` to your workflow permissions.",
    );
  }

  const url = `${requestUrl}&audience=${encodeURIComponent(audience)}`;
  const data = await httpRequest("GET", url, {
    Authorization: `Bearer ${requestToken}`,
  });

  const parsed = JSON.parse(data);
  if (!parsed.value) {
    throw new Error("OIDC token response missing `value` field.");
  }

  return parsed.value as string;
}

// ---------------------------------------------------------------------------
// Token exchange with backend (Cloudflare Worker)
// ---------------------------------------------------------------------------

async function exchangeForAppToken(oidcToken: string): Promise<string> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await httpRequest("POST", TOKEN_EXCHANGE_URL, {
        Authorization: `Bearer ${oidcToken}`,
        "Content-Type": "application/json",
      });

      const parsed = JSON.parse(data);
      const token = parsed.token || parsed.app_token;

      if (!token) {
        throw new Error("Token exchange response missing `token` field.");
      }

      return token as string;
    } catch (err) {
      if (attempt < maxAttempts) {
        const delay = attempt * 5_000;
        console.warn(
          `  Token exchange attempt ${attempt} failed, retrying in ${delay / 1000}s...`,
        );
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }

  throw new Error("Token exchange failed after all retries.");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function setupGitHubToken(): Promise<string> {
  const oidcToken = await getOidcToken("code-refinery");
  const appToken = await exchangeForAppToken(oidcToken);
  return appToken;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpRequest(
  method: string,
  urlStr: string,
  headers: Record<string, string>,
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === "https:" ? https : http;

    const req = mod.request(
      url,
      { method, headers, timeout: 30_000 },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${data.slice(0, 500)}`,
              ),
            );
          } else {
            resolve(data);
          }
        });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTP request timed out: ${method} ${urlStr}`));
    });

    if (body) req.write(body);
    req.end();
  });
}
