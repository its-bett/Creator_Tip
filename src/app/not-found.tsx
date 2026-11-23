import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#faf7f2] px-4 text-center text-slate-900">
      <div>
        <p className="text-6xl">🔍</p>
        <h1 className="mt-4 text-2xl font-black">Creator not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          This gift page does not exist. Check the link and try again.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-full bg-emerald-600 px-5 py-3 text-sm font-bold text-white hover:bg-emerald-700"
        >
          Visit the demo creator
        </Link>
      </div>
    </main>
  );
}
