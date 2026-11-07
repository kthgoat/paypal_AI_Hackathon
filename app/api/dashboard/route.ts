import { connection, NextResponse } from "next/server";
import {
  prisma,
  toBounty,
  toDecision,
  toPayout,
  toSettings,
  toVerdict,
} from "@/lib/db";
import type { DashboardSnapshot } from "@/lib/dashboard";

export async function GET() {
  await connection();
  try {
    const [bounties, claims, verdicts, decisions, payouts, settings] =
      await prisma.$transaction([
        prisma.bounty.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.claim.findMany({ select: { bountyId: true, githubUser: true } }),
        prisma.verdict.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.decision.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.payout.findMany({ orderBy: { createdAt: "desc" } }),
        prisma.settings.findUnique({ where: { id: "default" } }),
      ]);
    if (!settings)
      return NextResponse.json(
        {
          error:
            "Ledger is not initialized. Run migrations and npm run seed, then retry.",
        },
        { status: 503 },
      );
    const snapshot: DashboardSnapshot = {
      bounties: bounties.map(toBounty),
      contributors: claims,
      verdicts: verdicts.map(toVerdict),
      decisions: decisions.map(toDecision),
      payouts: payouts.map(toPayout),
      settings: toSettings(settings),
      asOf: new Date().toISOString(),
    };
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Dashboard ledger read failed", error);
    return NextResponse.json(
      {
        error:
          "Could not read the ledger. Check the database connection and migrations, then retry.",
      },
      { status: 503 },
    );
  }
}
