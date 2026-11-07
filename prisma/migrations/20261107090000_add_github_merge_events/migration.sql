CREATE TABLE "GitHubMergeEvent" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "repo" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "prUrl" TEXT NOT NULL,
    "prAuthor" TEXT NOT NULL,
    "mergeSha" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "GitHubMergeEvent_repo_prNumber_mergeSha_key" ON "GitHubMergeEvent"("repo", "prNumber", "mergeSha");
