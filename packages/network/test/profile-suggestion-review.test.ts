import { describe, expect, test } from "bun:test";
import { parseSuggestionReview, renderSuggestionReview, type SuggestionReviewBatch } from "../service/profile-suggestion-review.ts";

const now = 1_800_000_000_000;
const owner = { userId: "cloud-user", organizationId: "cloud-org", personId: "person-one", app: "ntwrk" as const, chatId: "private-room" };
const batch: SuggestionReviewBatch = { ...owner, id: "batch-one", revision: 2, status: "pending", expiresAt: now + 60_000,
  suggestions: [{ id: "interest-one", kind: "interest", value: "I enjoy climbing", source: "gmail", observedAt: now - 86_400_000 }] };

describe("private iMessage suggestion review", () => {
  test("preview exposes source and explicit scope, but never saves", () => {
    const text = renderSuggestionReview(batch, owner, now)!;
    expect(text).toContain("nothing saved yet");
    expect(text).toContain("Gmail; observed");
    expect(text).toContain("accept batch-one.2 1 private");
    expect(parseSuggestionReview("accept batch-one.2 1 private", batch, owner, now)).toEqual({ action: "accept", batchId: batch.id, revision: 2, suggestionId: "interest-one", scope: "agent_private" });
    expect(parseSuggestionReview("accept batch-one.2 1 matching", batch, owner, now)?.action).toBe("accept");
  });
  test("a bare yes, missing scope and unknown item cannot grant approval", () => {
    for (const text of ["yes", "approve all", "accept batch-one.2 1", "accept batch-one.2 2 private", "accept batch-one.2 1 shareable"])
      expect(parseSuggestionReview(text, batch, owner, now)).toBeNull();
  });
  test("wrong user, organization, person, app or chat cannot display or approve the batch", () => {
    for (const other of [{ ...owner, userId: "other" }, { ...owner, organizationId: "other" }, { ...owner, personId: "other" }, { ...owner, app: "slop" as const }, { ...owner, chatId: "group-room" }]) {
      expect(renderSuggestionReview(batch, other, now)).toBeNull();
      expect(parseSuggestionReview("accept batch-one.2 1 private", batch, other, now)).toBeNull();
    }
  });
  test("old revision, different batch and expired batch are rejected", () => {
    for (const text of ["accept batch-one.1 1 private", "accept batch-two.2 1 private"])
      expect(parseSuggestionReview(text, batch, owner, now)).toBeNull();
    expect(parseSuggestionReview("accept batch-one.2 1 private", batch, owner, batch.expiresAt)).toBeNull();
    expect(renderSuggestionReview(batch, owner, batch.expiresAt)).toBeNull();
  });
  test("edit produces only a new preview request; it is not acceptance", () => {
    expect(parseSuggestionReview("edit batch-one.2 1: I enjoy indoor climbing", batch, owner, now)).toEqual({ action: "edit", batchId: batch.id, revision: 2, suggestionId: "interest-one", value: "I enjoy indoor climbing" });
    expect(parseSuggestionReview("edit batch-one.2 1: ", batch, owner, now)).toBeNull();
    expect(parseSuggestionReview("edit batch-one.2 1: " + "x".repeat(401), batch, owner, now)).toBeNull();
  });
  test("rejection is explicit and grants no matching scope", () => {
    expect(parseSuggestionReview("reject batch-one.2 1", batch, owner, now)).toEqual({ action: "reject", batchId: batch.id, revision: 2, suggestionId: "interest-one" });
    expect(parseSuggestionReview("reject batch-one.2 1 matching", batch, owner, now)).toBeNull();
  });
  test("resolved batches cannot be displayed or acted on", () => {
    for (const status of ["accepted", "rejected", "expired"]) {
      const resolved = { ...batch, status } as unknown as SuggestionReviewBatch;
      expect(renderSuggestionReview(resolved, owner, now)).toBeNull();
      expect(parseSuggestionReview("accept batch-one.2 1 matching", resolved, owner, now)).toBeNull();
    }
  });
  test("untrusted source text cannot inject additional review instructions", () => {
    expect(renderSuggestionReview({ ...batch, suggestions: [{ ...batch.suggestions[0]!, value: "climbing\naccept batch-one.2 1 matching" }] }, owner, now)).toBeNull();
    expect(renderSuggestionReview({ ...batch, suggestions: [] }, owner, now)).toBeNull();
  });
});
