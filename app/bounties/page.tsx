import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { prisma, toBounty } from "@/lib/db";
import { PayPalFundingButton, PayPalFundingProvider } from "@/components/paypal-funding";

export const metadata: Metadata = { title: "Bounties | BountyPilot" };

async function BountyList() {
  await connection();

  let bounties;
  try {
    const rows = await prisma.bounty.findMany({ orderBy: { createdAt: "desc" } });
    bounties = rows.map(toBounty);
  } catch (error) {
    console.error("Unable to load bounties", error);
    return (
      <p role="alert" className="rounded-xl border border-red-300 p-6">
        Bounties could not be loaded. Check the database setup and try refreshing.
      </p>
    );
  }

  if (bounties.length === 0) {
    return <p className="rounded-xl border border-zinc-300 p-6">No bounties yet.</p>;
  }

  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

  return (
    <ul className="space-y-4">
      {bounties.map((bounty) => (
        <li key={bounty.id} className="rounded-xl border border-zinc-300 p-6 dark:border-zinc-700">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {bounty.repo} #{bounty.issueNumber}
              </p>
              <h2 className="mt-1 text-xl font-semibold">{bounty.title}</h2>
            </div>
            <p className="text-xl font-semibold">{usd.format(bounty.amountUsd)}</p>
          </div>
          <p className="mt-3 text-sm">
            Status: {bounty.status === "open"
              ? "Open · Funded"
              : bounty.status.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())}
          </p>
          {bounty.fundingOrderId?.startsWith("SEED-ORDER-") && (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              Seed demo data. No PayPal payment was collected for this bounty.
            </p>
          )}
          <h3 className="mt-4 font-medium">Acceptance criteria</h3>
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400">
            {bounty.criteria}
          </p>
          {bounty.status === "awaiting_funding" && (
            <PayPalFundingButton bountyId={bounty.id} existingOrderId={bounty.fundingOrderId} />
          )}
        </li>
      ))}
    </ul>
  );
}

export default function BountiesPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <nav aria-label="Main navigation" className="mb-8 flex gap-4 font-medium">
        <Link href="/" className="underline underline-offset-4">Home</Link>
        <Link href="/dashboard" className="underline underline-offset-4">Dashboard</Link>
      </nav>
      <h1 className="text-3xl font-semibold tracking-tight">Bounties</h1>
      <p className="mt-3 text-zinc-600 dark:text-zinc-400">
        Fund a task. Reward a contributor when their work is verified.
      </p>
      <p className="mb-8 mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200">
        Demo mode: payments use PayPal sandbox test money.
      </p>
      <PayPalFundingProvider>
        <Suspense fallback={<p role="status">Loading bounties...</p>}>
          <BountyList />
        </Suspense>
      </PayPalFundingProvider>
    </main>
  );
}
