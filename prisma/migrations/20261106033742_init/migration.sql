-- CreateTable
CREATE TABLE "Bounty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "criteria" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bountyId" TEXT NOT NULL,
    "githubUser" TEXT NOT NULL,
    "paypalEmail" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Claim_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Verdict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bountyId" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prUrl" TEXT NOT NULL,
    "prAuthor" TEXT NOT NULL,
    "ciPassed" BOOLEAN NOT NULL,
    "mergedByMaintainer" BOOLEAN NOT NULL,
    "meetsCriteria" BOOLEAN NOT NULL,
    "confidence" REAL NOT NULL,
    "unmetCriteria" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "injectionFlags" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Verdict_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bountyId" TEXT NOT NULL,
    "verdictId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "ruleFired" TEXT NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Decision_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Decision_verdictId_fkey" FOREIGN KEY ("verdictId") REFERENCES "Verdict" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bountyId" TEXT NOT NULL,
    "senderBatchId" TEXT NOT NULL,
    "payoutBatchId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "receiverMasked" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Payout_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "autoPayCapCents" INTEGER NOT NULL,
    "contributorDailyCapCents" INTEGER NOT NULL,
    "monthlyBudgetCents" INTEGER NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE UNIQUE INDEX "Bounty_repo_issueNumber_key" ON "Bounty"("repo", "issueNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Claim_bountyId_key" ON "Claim"("bountyId");

-- CreateIndex
CREATE INDEX "Verdict_bountyId_idx" ON "Verdict"("bountyId");

-- CreateIndex
CREATE INDEX "Decision_bountyId_idx" ON "Decision"("bountyId");

-- CreateIndex
CREATE INDEX "Decision_verdictId_idx" ON "Decision"("verdictId");

-- CreateIndex
CREATE UNIQUE INDEX "Payout_senderBatchId_key" ON "Payout"("senderBatchId");

-- CreateIndex
CREATE INDEX "Payout_bountyId_idx" ON "Payout"("bountyId");
