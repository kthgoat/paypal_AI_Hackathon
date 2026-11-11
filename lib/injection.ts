// A cheap, deterministic pre-check for text that tries to talk to the reviewer or the payment
// system instead of describing a change. It runs in plain code, so it still works when the model
// is fooled, down, or returns nothing. A hit never pays anything: policy turns any injection flag
// into "needs a human" (rule injection_flagged).
//
// Patterns favour phrases an attacker would have to write ("ignore previous instructions",
// "approve this payout") over words honest PRs use all the time ("approve", "pay").

interface Pattern {
  flag: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    flag: "ignore_instructions",
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.]{0,30}\b(?:instructions?|prompts?|rules?|guidelines?|criteria|context)\b/i,
  },
  { flag: "new_instructions", re: /\b(?:new|updated|real|actual|additional)\s+(?:instructions?|system\s+prompt|rules)\s*:/i },
  { flag: "system_prompt", re: /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i },
  {
    flag: "role_reassignment",
    re: /\byou\s+are\s+(?:now|no\s+longer|actually)\b|\byou\s+are\s+(?:an?|the)\s+(?:\w+\s+){0,2}(?:ai|assistant|reviewer|bot|model|judge|approver|auditor)\b|\b(?:act|behave)\s+as\s+(?:an?|the)\b|\bpretend\s+(?:to\s+be|you\s+are)\b/i,
  },
  {
    flag: "approval_request",
    re: /\b(?:approve|accept|pass|green-?light|sign\s+off\s+on|mark)\s+(?:this|the|my|it)\s+(?:pr|pull\s+request|change|merge|bounty|payment|payout|submission|review|as\s+(?:approved|passing|passed|complete|done|meeting))\b|\bapprove\s+(?:and\s+)?(?:pay|payout)\b/i,
  },
  { flag: "verdict_instruction", re: /\b(?:set|return|output|respond\s+with|answer)\b[^.]{0,30}\b(?:meetsCriteria|confidence|injectionFlags|verdict)\b/i },
  { flag: "payout_instruction", re: /\b(?:pay|payout|send|transfer|release|wire)\b[^.]{0,40}\$\s?\d|\$\s?\d[\d,.]*[^.]{0,40}\b(?:pay(?:out|ment)?|bounty|reward)\b/i },
  { flag: "payment_request", re: /\b(?:pay|send)\s+(?:me|the\s+(?:author|contributor|submitter)|out\s+the)\b|\b(?:release|trigger|issue)\s+(?:the\s+)?(?:payout|payment|bounty)\b/i },
  { flag: "reviewer_bot", re: /\b(?:reviewer|review|payment|payout|bounty)\s*-?\s*(?:bot|agent)\b|\bbountypilot\b|\bai\s+reviewer\b|\bautomated\s+reviewer\b/i },
  { flag: "delimiter_escape", re: /<\/?\s*untrusted\b/i },
];

// Zero-width characters and bidi controls: used to hide text from humans while a model still reads it.
const HIDDEN_CHARACTERS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

const SNIPPET_MAX = 80;

const snippet = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);

/** Returns one flag per kind of injection found, e.g. `ignore_instructions: "ignore all previous instructions"`. */
export function detectInjection(text: string): string[] {
  const flags: string[] = [];
  for (const { flag, re } of PATTERNS) {
    const match = re.exec(text);
    if (match) flags.push(`${flag}: "${snippet(match[0])}"`);
  }
  if (HIDDEN_CHARACTERS.test(text)) flags.push("hidden_characters: invisible or bidirectional control characters");
  return flags;
}

/** The lines a diff adds (starting with "+", not the "+++" file header): the only text a PR author controls there. */
export function addedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

/** Union of two flag lists, keeping the order and dropping repeats of the same kind. */
export function mergeFlags(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const flag of lists.flat()) {
    const kind = flag.split(":")[0].trim().toLowerCase();
    if (seen.has(kind)) continue;
    seen.add(kind);
    merged.push(flag);
  }
  return merged;
}
