import { Suspense } from "react";
import CreatorDashboard from "@/components/creator-dashboard";

export default function DashboardPage({
  params,
}: PageProps<"/dashboard/[username]">) {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-screen place-items-center bg-[#faf7f2] px-4">
          <div className="h-9 w-9 animate-spin rounded-full border-4 border-emerald-100 border-t-emerald-600" />
        </main>
      }
    >
      <CreatorDashboard params={params} />
    </Suspense>
  );
}
