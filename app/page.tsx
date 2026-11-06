import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-4xl font-semibold tracking-tight">BountyPilot</h1>
      <p className="text-lg text-zinc-600 dark:text-zinc-400">
        An agent that pays open-source bounty contributors through PayPal once
        their merged PR is verified.
      </p>
      <nav className="flex gap-4 font-medium">
        <Link href="/bounties" className="underline underline-offset-4">
          Bounties
        </Link>
        <Link href="/dashboard" className="underline underline-offset-4">
          Dashboard
        </Link>
      </nav>
    </main>
  );
}
