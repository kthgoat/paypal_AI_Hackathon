-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bounty" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repo" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "criteria" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_funding',
    "fundingOrderId" TEXT,
    "fundingCaptureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Bounty" ("amountCents", "createdAt", "criteria", "id", "issueNumber", "repo", "status", "title") SELECT "amountCents", "createdAt", "criteria", "id", "issueNumber", "repo", "status", "title" FROM "Bounty";
DROP TABLE "Bounty";
ALTER TABLE "new_Bounty" RENAME TO "Bounty";
CREATE UNIQUE INDEX "Bounty_repo_issueNumber_key" ON "Bounty"("repo", "issueNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
