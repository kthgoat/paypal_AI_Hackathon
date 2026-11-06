export type BountyStatus = 'awaiting_funding' | 'open' | 'claimed' | 'in_review' | 'awaiting_approval' | 'paid' | 'rejected' | 'refunded' | 'failed'; // 'open' means funded

export interface Bounty { id: string; repo: string; issueNumber: number; title: string; amountUsd: number; criteria: string; status: BountyStatus; fundingOrderId: string | null; fundingCaptureId: string | null; createdAt: string; }
export interface Claim { id: string; bountyId: string; githubUser: string; paypalEmail: string; createdAt: string; }

export interface Verdict {
  id: string; bountyId: string; prNumber: number; prUrl: string; prAuthor: string;
  ciPassed: boolean; mergedByMaintainer: boolean;
  meetsCriteria: boolean; confidence: number; // 0..1
  unmetCriteria: string[]; summary: string; injectionFlags: string[];
  model: string; createdAt: string;
}

export type DecisionOutcome = 'auto_pay' | 'needs_approval' | 'blocked';
export interface Decision { id: string; bountyId: string; verdictId: string; outcome: DecisionOutcome; ruleFired: string; decidedBy: 'policy' | 'maintainer'; createdAt: string; }

export interface Payout {
  id: string; bountyId: string; senderBatchId: string; payoutBatchId: string | null;
  amountUsd: number; status: string; // mirrors PayPal's transaction_status, e.g. PENDING, SUCCESS, UNCLAIMED, FAILED
  receiverMasked: string; createdAt: string; updatedAt: string;
}

export interface Settings { autoPayCapUsd: number; contributorDailyCapUsd: number; monthlyBudgetUsd: number; paused: boolean; }
