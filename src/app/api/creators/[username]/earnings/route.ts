import { createHash, timingSafeEqual } from "node:crypto";
import { getCreatorEarnings } from "@/lib/db";
import { clientKey, isRateLimited } from "@/lib/rate-limit";

/** Demo-only fallback so the dashboard is usable before CREATOR_DASHBOARD_TOKEN is set. */
const DEV_TOKEN = "tipjar-demo";

function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  if (isRateLimited(`earnings:${clientKey(request)}`)) {
    return Response.json(
      { error: "Too many attempts. Please wait a minute and try again." },
      { status: 429 },
    );
  }

  const expected = process.env.CREATOR_DASHBOARD_TOKEN?.trim();
  const usingDemoToken = !expected && process.env.NODE_ENV !== "production";
  const secret = expected || (usingDemoToken ? DEV_TOKEN : "");

  if (!secret) {
    return Response.json(
      { error: "The creator dashboard is not configured on this server." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  let bodyToken = "";
  try {
    const body = (await request.json()) as { token?: unknown };
    if (typeof body.token === "string") bodyToken = body.token.trim();
  } catch {
    // An empty or malformed body is fine when the token is sent as a bearer header.
  }

  if (!tokenMatches(bearer || bodyToken, secret)) {
    return Response.json({ error: "Incorrect access code." }, { status: 401 });
  }

  const { username } = await params;
  const earnings = await getCreatorEarnings(username);
  if (!earnings) {
    return Response.json({ error: "Creator not found." }, { status: 404 });
  }

  return Response.json(
    { ...earnings, usingDemoToken },
    { headers: { "Cache-Control": "no-store" } },
  );
}
