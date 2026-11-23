import { notFound } from "next/navigation";
import { Suspense } from "react";
import CreatorPage from "@/components/creator-page";
import { getCreatorProfile } from "@/lib/db";

function ProfileSkeleton() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#faf7f2] px-4">
      <div className="w-full max-w-5xl animate-pulse rounded-[28px] bg-white p-8 shadow-sm">
        <div className="h-40 rounded-3xl bg-emerald-100" />
        <div className="mt-6 h-6 w-1/3 rounded bg-slate-200" />
        <div className="mt-3 h-4 w-2/3 rounded bg-slate-100" />
        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          <div className="h-28 rounded-2xl bg-slate-100" />
          <div className="h-28 rounded-2xl bg-slate-100" />
          <div className="h-28 rounded-2xl bg-slate-100" />
        </div>
      </div>
    </main>
  );
}

async function ProfileContent({ username }: { username: string }) {
  const profile = await getCreatorProfile(username);
  if (!profile) notFound();
  return <CreatorPage profile={profile} />;
}

export function Profile({ username }: { username: string }) {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <ProfileContent username={username} />
    </Suspense>
  );
}

export function ProfileFromParams({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  return (
    <Suspense fallback={<ProfileSkeleton />}>
      <ParamsContent params={params} />
    </Suspense>
  );
}

async function ParamsContent({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <ProfileContent username={username} />;
}
