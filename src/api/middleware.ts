import type { Env } from "../index";
import { getSessionWithUser } from "../db/queries";

export interface AuthContext {
  userId: number;
  githubId: number;
  githubLogin: string;
  avatarUrl: string | null;
}

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticate(
  request: Request,
  env: Env,
): Promise<AuthContext | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const token = parseCookie(cookieHeader, "session");
  if (!token) return null;

  const tokenHash = await hashToken(token);
  const session = await getSessionWithUser(env.DB, tokenHash);
  if (!session) return null;

  return {
    userId: session.userId,
    githubId: session.githubId,
    githubLogin: session.githubLogin,
    avatarUrl: session.avatarUrl,
  };
}

export async function requireAuth(
  request: Request,
  env: Env,
): Promise<AuthContext | Response> {
  const auth = await authenticate(request, env);
  if (!auth) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return auth;
}

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export function checkCsrf(request: Request, env: Env): Response | null {
  if (!MUTATION_METHODS.has(request.method)) return null;

  const origin = request.headers.get("Origin");
  if (!origin || origin !== env.DASHBOARD_ORIGIN) {
    return new Response(JSON.stringify({ error: "CSRF check failed" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

export function setSessionCookie(token: string, secure: boolean): string {
  const sameSite = secure ? "None" : "Lax";
  const secureFlag = secure ? "; Secure" : "";
  return `session=${encodeURIComponent(token)}; HttpOnly${secureFlag}; SameSite=${sameSite}; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie(secure: boolean): string {
  const sameSite = secure ? "None" : "Lax";
  const secureFlag = secure ? "; Secure" : "";
  return `session=; HttpOnly${secureFlag}; SameSite=${sameSite}; Path=/; Max-Age=0`;
}

export function clearOAuthStateCookie(secure: boolean): string {
  const secureFlag = secure ? "; Secure" : "";
  return `__oauth_state=; HttpOnly${secureFlag}; SameSite=Lax; Path=/auth; Max-Age=0`;
}

export { hashToken };
