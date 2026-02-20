import type { Env } from "../index";
import type { AuthContext } from "./middleware";
import { getUsageStats } from "../db/queries";

export async function handleGetUsage(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(request.url);
  const period = Math.min(
    365,
    Math.max(1, parseInt(url.searchParams.get("period") || "30", 10)),
  );

  const stats = await getUsageStats(env.DB, auth.userId, period);

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
