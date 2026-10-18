import { parseProfileReviewOwnerRequest, type ProfileReviewOwnerRequest } from "./profile-review-owner.js";

export const LEARNING_CONSENT_CONTEXT_PATH = "/internal/profile-suggestions/consent-context";
export interface LearningConsentContextRequest {
  version: 1;
  purpose: "network_profile_learning_v1";
  review: ProfileReviewOwnerRequest;
  selectionSha256: string;
}
export interface LearningConsentContextProof {
  version: 1;
  purpose: "network-learning-membership-v1";
  requestSha256: string;
  requestNonce: string;
  channel: ProfileReviewOwnerRequest["channel"];
  messageId: string;
  commandSha256: string;
  networkAuthority: ProfileReviewOwnerRequest["networkAuthority"];
  personId: string;
  app: ProfileReviewOwnerRequest["app"];
  memberId: string;
  selectionSha256: string;
  issuedAt: number;
  expiresAt: number;
}

export function parseLearningConsentContextRequest(value: unknown): LearningConsentContextRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const review = parseProfileReviewOwnerRequest(v.review);
  if (Object.keys(v).sort().join() !== "purpose,review,selectionSha256,version" || v.version !== 1
    || v.purpose !== "network_profile_learning_v1" || !review || review.action !== "collect"
    || typeof v.selectionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.selectionSha256)) return undefined;
  return value as LearningConsentContextRequest;
}

/** Verify existing service HMAC over the exact body before parsing this identity-only proof. */
export function parseLearningConsentContextProof(value: unknown, request: LearningConsentContextRequest, requestSha256: string, now: number): LearningConsentContextProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== "app,channel,commandSha256,expiresAt,issuedAt,memberId,messageId,networkAuthority,personId,purpose,requestNonce,requestSha256,selectionSha256,version"
    || v.version !== 1 || v.purpose !== "network-learning-membership-v1"
    || !/^[a-f0-9]{64}$/.test(requestSha256) || v.requestSha256 !== requestSha256
    || v.requestNonce !== request.review.requestNonce || v.channel !== request.review.channel || v.messageId !== request.review.messageId
    || v.commandSha256 !== request.review.commandSha256 || v.app !== request.review.app || v.memberId !== request.review.memberId
    || v.selectionSha256 !== request.selectionSha256 || JSON.stringify(v.networkAuthority) !== JSON.stringify(request.review.networkAuthority)
    || typeof v.personId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.personId)
    || !Number.isSafeInteger(now) || !Number.isSafeInteger(v.issuedAt) || !Number.isSafeInteger(v.expiresAt)
    || (v.issuedAt as number) > now || (v.expiresAt as number) <= now || (v.expiresAt as number) <= (v.issuedAt as number)
    || (v.expiresAt as number) - (v.issuedAt as number) > 30_000) return undefined;
  return value as LearningConsentContextProof;
}
