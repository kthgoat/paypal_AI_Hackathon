-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GitHubMergeEvent" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "repo" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prUrl" TEXT NOT NULL,
    "prAuthor" TEXT NOT NULL,
    "mergeSha" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimedAt" DATETIME,
    "processedAt" DATETIME,
    "verdictId" TEXT
);
INSERT INTO "new_GitHubMergeEvent" ("deliveryId", "mergeSha", "prAuthor", "prNumber", "prUrl", "receivedAt", "repo") SELECT "deliveryId", "mergeSha", "prAuthor", "prNumber", "prUrl", "receivedAt", "repo" FROM "GitHubMergeEvent";
DROP TABLE "GitHubMergeEvent";
ALTER TABLE "new_GitHubMergeEvent" RENAME TO "GitHubMergeEvent";
CREATE UNIQUE INDEX "GitHubMergeEvent_repo_prNumber_mergeSha_key" ON "GitHubMergeEvent"("repo", "prNumber", "mergeSha");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
