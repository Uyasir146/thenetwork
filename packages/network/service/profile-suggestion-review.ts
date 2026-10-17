import type { AppId } from "../../core/src/types.ts";

/** A private display projection. It contains no source credentials or raw Google records. */
export interface SuggestionReviewBatch {
  id: string;
  revision: number;
  personId: string;
  userId: string;
  organizationId: string;
  app: AppId;
  chatId: string;
  expiresAt: number;
  status: "pending";
  suggestions: readonly {
    id: string;
    kind: "interest" | "goal" | "availability_pattern";
    value: string;
    source: "gmail" | "google_calendar";
    observedAt: number;
  }[];
}

function currentBatch(batch: SuggestionReviewBatch, owner: { personId: string; userId: string; organizationId: string; app: AppId; chatId: string }, now: number): boolean {
  return batch.status === "pending" && batch.userId === owner.userId && batch.organizationId === owner.organizationId
    && batch.personId === owner.personId && batch.app === owner.app && batch.chatId === owner.chatId
    && Number.isSafeInteger(now) && Number.isSafeInteger(batch.expiresAt) && now < batch.expiresAt
    && /^[A-Za-z0-9_-]{1,64}$/.test(batch.id) && Number.isSafeInteger(batch.revision) && batch.revision > 0
    && batch.suggestions.length > 0 && batch.suggestions.length <= 5
    && new Set(batch.suggestions.map(s => s.id)).size === batch.suggestions.length
    && batch.suggestions.every(s => /^[A-Za-z0-9_-]{1,64}$/.test(s.id) && s.value.trim().length > 0 && s.value.length <= 400
      && !/[\r\n\u0000-\u001f\u007f]/.test(s.value) && Number.isSafeInteger(s.observedAt) && s.observedAt <= now
      && ["gmail", "google_calendar"].includes(s.source)
      && ["interest", "goal", "availability_pattern"].includes(s.kind));
}

export function renderSuggestionReview(batch: SuggestionReviewBatch, owner: { personId: string; userId: string; organizationId: string; app: AppId; chatId: string }, now: number): string | null {
  if (!currentBatch(batch, owner, now)) return null;
  const token = `${batch.id}.${batch.revision}`;
  return [
    `Suggestions for ${batch.app} — nothing saved yet (${token}).`,
    ...batch.suggestions.map((s, i) => `${i + 1}. ${s.value} (${s.source === "gmail" ? "Gmail" : "Calendar"}; observed ${new Date(s.observedAt).toISOString().slice(0, 10)})`),
    `Accept one: accept ${token} 1 private — or use matching to allow matching use.`,
    `Edit one: edit ${token} 1: your wording. Edits need a new review before acceptance.`,
    `Reject one: reject ${token} 1. Each command applies only to this batch.`,
  ].join("\n");
}

/** Returns intent only. The store must atomically recheck owner, revision, expiry and pending state. */
export function parseSuggestionReview(text: string, batch: SuggestionReviewBatch, owner: { personId: string; userId: string; organizationId: string; app: AppId; chatId: string }, now: number):
  | { action: "accept"; batchId: string; revision: number; suggestionId: string; scope: "agent_private" | "matchable" }
  | { action: "reject"; batchId: string; revision: number; suggestionId: string }
  | { action: "edit"; batchId: string; revision: number; suggestionId: string; value: string }
  | null {
  if (!currentBatch(batch, owner, now)) return null;
  const match = /^(accept|reject|edit) ([A-Za-z0-9_-]+)\.([1-9][0-9]*) ([1-5])(?:(?: (private|matching))|(?:: ([^\r\n]+)))?$/.exec(text.trim());
  if (!match || match[2] !== batch.id || Number(match[3]) !== batch.revision) return null;
  const suggestion = batch.suggestions[Number(match[4]) - 1];
  if (!suggestion) return null;
  const identity = { batchId: batch.id, revision: batch.revision, suggestionId: suggestion.id };
  if (match[1] === "accept" && match[5] && !match[6]) return { action: "accept", ...identity, scope: match[5] === "private" ? "agent_private" : "matchable" };
  if (match[1] === "reject" && !match[5] && !match[6]) return { action: "reject", ...identity };
  if (match[1] === "edit" && !match[5] && match[6]) {
    const value = match[6].trim();
    if (value.length > 0 && value.length <= 400 && !/[\u0000-\u001f\u007f]/.test(value)) return { action: "edit", ...identity, value };
  }
  return null;
}
