import type { Env } from "../index";
import {
  upsertUser,
  createSession,
  deleteSession,
  deleteExpiredSessions,
  linkInstallationsToUser,
  upsertInstallation,
} from "../db/queries";
import {
  authenticate,
  hashToken,
  setSessionCookie,
  clearSessionCookie,
  clearOAuthStateCookie,
} from "./middleware";

const GITHUB_OAUTH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "code-refinery";
const OAUTH_STATE_MAX_AGE = 300; // 5 minutes

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isSecureOrigin(origin: string): boolean {
  return origin.startsWith("https://") || origin.startsWith("http://localhost");
}

function parseCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function handleAuthLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  const state = randomHex(16);
  const secure = env.DASHBOARD_ORIGIN?.startsWith("https://");
  const secureFlag = secure ? "; Secure" : "";

  const origin = new URL(request.url).origin.replace(/^http:\/\//, "https://");
  const redirectUri = `${origin}/auth/callback`;

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "read:user",
    state,
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${GITHUB_OAUTH_AUTHORIZE}?${params}`,
      "Set-Cookie": `__oauth_state=${state}; HttpOnly${secureFlag}; SameSite=Lax; Path=/auth; Max-Age=${OAUTH_STATE_MAX_AGE}`,
    },
  });
}

export async function handleAuthCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  // Verify state matches cookie
  const cookieHeader = request.headers.get("Cookie") || "";
  const savedState = parseCookie(cookieHeader, "__oauth_state");

  if (!savedState || savedState !== state) {
    return new Response("Invalid OAuth state — possible CSRF", { status: 403 });
  }

  // Validate redirect target
  if (!isSecureOrigin(env.DASHBOARD_ORIGIN)) {
    return new Response("Invalid DASHBOARD_ORIGIN configuration", {
      status: 500,
    });
  }

  // Exchange code for access token
  const tokenResponse = await fetch(GITHUB_OAUTH_TOKEN, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenResponse.ok) {
    return new Response("Failed to exchange OAuth code", { status: 502 });
  }

  const tokenData: { access_token?: string; error?: string } =
    await tokenResponse.json();

  if (!tokenData.access_token) {
    return new Response(
      `OAuth error: ${tokenData.error || "no access token"}`,
      { status: 400 },
    );
  }

  const ghToken = tokenData.access_token;

  // Fetch user info
  const userResponse = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
  });

  if (!userResponse.ok) {
    return new Response("Failed to fetch GitHub user", { status: 502 });
  }

  const ghUser: { id: number; login: string; avatar_url: string } =
    await userResponse.json();

  // Upsert user in D1
  const userId = await upsertUser(
    env.DB,
    ghUser.id,
    ghUser.login,
    ghUser.avatar_url,
  );

  // Fetch user's installations of our GitHub App and link them
  try {
    const installationsResponse = await fetch(
      `${GITHUB_API_BASE}/user/installations`,
      {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": USER_AGENT,
        },
      },
    );

    if (!installationsResponse.ok) {
      console.error(
        `[auth] GET /user/installations failed: ${installationsResponse.status} ${installationsResponse.statusText}`,
      );
    } else {
      const installData: {
        installations: Array<{ id: number; app_id: number; app_slug: string }>;
      } = await installationsResponse.json();

      console.log(
        `[auth] Found ${installData.installations.length} installation(s) for user=${ghUser.login}: ` +
          installData.installations.map((i) => `${i.app_slug}(${i.id})`).join(", "),
      );

      // Filter to only our app's installations
      const appId = parseInt(env.GITHUB_APP_ID, 10);
      const ourInstallations = installData.installations.filter(
        (inst) => inst.app_id === appId,
      );

      console.log(
        `[auth] Matched ${ourInstallations.length} installation(s) for app_id=${appId}`,
      );

      // Ensure installations exist in our DB, then link to user
      const ghInstIds: number[] = [];
      for (const inst of ourInstallations) {
        await upsertInstallation(env.DB, inst.id);
        ghInstIds.push(inst.id);
      }

      if (ghInstIds.length > 0) {
        await linkInstallationsToUser(env.DB, userId, ghInstIds);
        console.log(
          `[auth] Linked ${ghInstIds.length} installation(s) to user=${ghUser.login} (userId=${userId})`,
        );
      } else {
        console.warn(
          `[auth] No installations to link for user=${ghUser.login}. ` +
            `User may not have installed the GitHub App.`,
        );
      }
    }
  } catch (err) {
    // Non-fatal: user can still log in even if installation linking fails
    console.error("[auth] Failed to link installations to user:", err);
  }

  // Generate session token
  const sessionToken = randomHex(32);
  const tokenHash = await hashToken(sessionToken);
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  await createSession(env.DB, userId, tokenHash, expiresAt);

  // Cleanup expired sessions (non-blocking)
  deleteExpiredSessions(env.DB).catch(() => {});

  // Cross-origin setup (dashboard on localhost, API behind HTTPS tunnel) needs SameSite=None; Secure
  const apiOrigin = new URL(request.url).origin.replace(/^http:\/\//, "https://");
  const crossOrigin = apiOrigin !== env.DASHBOARD_ORIGIN;
  const secure = crossOrigin || env.DASHBOARD_ORIGIN.startsWith("https://");

  return new Response(null, {
    status: 302,
    headers: new Headers([
      ["Location", env.DASHBOARD_ORIGIN],
      ["Set-Cookie", setSessionCookie(sessionToken, secure)],
      ["Set-Cookie", clearOAuthStateCookie(secure)],
    ]),
  });
}

export async function handleAuthLogout(
  request: Request,
  env: Env,
): Promise<Response> {
  const cookieHeader = request.headers.get("Cookie") || "";
  const token = parseCookie(cookieHeader, "session");

  if (token) {
    const tokenHash = await hashToken(token);
    await deleteSession(env.DB, tokenHash);
  }

  const apiOrigin = new URL(request.url).origin.replace(/^http:\/\//, "https://");
  const crossOrigin = apiOrigin !== env.DASHBOARD_ORIGIN;
  const secure = crossOrigin || env.DASHBOARD_ORIGIN.startsWith("https://");

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": clearSessionCookie(secure),
    },
  });
}

export async function handleAuthMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await authenticate(request, env);

  if (!auth) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(
    JSON.stringify({
      userId: auth.userId,
      githubId: auth.githubId,
      githubLogin: auth.githubLogin,
      avatarUrl: auth.avatarUrl,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}
