import { notFound } from "next/navigation";
import { Suspense } from "react";

// DEV ONLY. Landing page for PayPal's redirect flow while testing bounty funding by hand.
// It does NOT capture anything: capturing happens only through
// POST /api/bounties/[id]/fund/capture. In production this route is a 404.
export default function FundingReturnPage({ searchParams }: PageProps<"/dev/funding-return">) {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-3 px-6">
      <Suspense fallback={<p>Loading…</p>}>
        <Message searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

// searchParams is request-time data, so it is read inside <Suspense> (Cache Components).
async function Message({
  searchParams,
}: {
  searchParams: PageProps<"/dev/funding-return">["searchParams"];
}) {
  const { cancelled } = await searchParams;

  if (cancelled) {
    return (
      <>
        <h1 className="text-2xl font-semibold">Cancelled</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          The payment was not approved. Nothing was charged.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold">Approval received — go back to the terminal</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Nothing has been captured yet. The bounty opens only after the capture route runs.
      </p>
    </>
  );
}
