import { getCreatorProfile } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params;
  const profile = await getCreatorProfile(username);

  if (!profile) {
    return Response.json({ error: "Creator not found." }, { status: 404 });
  }

  return Response.json(profile, { headers: { "Cache-Control": "no-store" } });
}
