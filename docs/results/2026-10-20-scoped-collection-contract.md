# Scoped collection authorization contract (source only)

Collection requires the exact stored inbound command `collect UUID gmail,calendar from ISO until ISO timezone IANA fields interest,goal retain delete|keep` (supported subsets use the shared parser). Do not trim or reconstruct the original bytes before `commandSha256`. Plain `collect UUID` is a help/entry lookup and does not authorize collection. Source windows are at most 31 days. The consent lifetime is fixed at original stored `arrived_at + 24h`; pending expiry may be shorter and cannot exceed that bound.

`learning-collection-command.ts` exports the strict command/scope parser, fixed deadline, canonical eight-key selection serializer and SHA256 helper. `learning-consent-context.ts` adds `parseLearningCollectionSelection` and `learningSelectionMatchesStoredCommand`; its signed request accepts optional `selection`. Confirmation must send the exact identity-free eight-key DTO plus its canonical `hashNetworkCollectionSelection` digest. The endpoint independently compares it with the stored command/batch/source order/window/timezone/fields/retention and original arrival deadline. A Google connection may cover both source types; source types are unique, connection IDs need not differ. No raw Google content belongs in this DTO.

The only no-selection request is the existing nonauthorizing entry lookup (for a valid stored plain-help or scoped command): `selectionSha256 = SHA256(JSON.stringify({purpose:"network-learning-entry-v1"}))`, exported as `NETWORK_LEARNING_ENTRY_SELECTION_SHA256`. An arbitrary digest is refused. A marker proof is context-only and must never be consumed as selected-scope confirmation. This proof remains identity-only and creates no consent, batch or source access. Scoped confirmation without its DTO fails closed; Cloud producer must send `selection` and use the same canonical serializer/hash rather than generic input object property order.

`SuggestionTurnIdentity.collectionProposal` carries validated collection scope to the server-local Cloud owner resolver. The endpoint, owner resolver and claimed `ProfileSuggestions.propose` independently rejoin that proposal to the stored original command; the context endpoint independently joins the displayed selection. Existing HMAC, request/command hashes, route, person/member/currentness, STOP/holds and replay/transaction fences remain in force. Claim context optionally carries original `commandSha256`; the HTTP endpoint always supplies it. Non-collection review behavior is unchanged.

Source-authored integration cases exercise the shared grammar vectors through the real owning endpoint/SQL transaction, collection scope mismatch, retention widening, and selection digest/DTO mismatch. No tests, database operations, provider requests or runtime qualification were executed for this change. No schema migration or default enablement was added.


## Accepted intake remains ineligible for automated matching

Acceptance saves the approved fact and its existing `source`/`inferred` provenance, with durable `source-suggestion:<suggestion UUID>` namespace and linked suggestion `fact_id`. This identifies `network_profile_learning_v1` intake purpose without a new schema column. `facetOf` exposes that purpose on owned profile readback. No approved fact or privacy choice is erased/relabelled.

The default `loadSnapshot` SQL input used by the live Network and Observatory engine excludes `gmail`, `google_calendar`, and the source-suggestion namespace before matching, planning, embeddings and judges see it. Explicit internal `purpose: "profile_review"` preserves the prior scoped profile-review readback; it is not a matcher option or a new public endpoint. The existing direct owned profile/detail reads remain available.

A shared static SQL predicate also fences the two background reads bypassing snapshots: weekly bias aggregation and adult-verification tags. It interpolates only fixed SQL clauses (unaliased or the fixed `f` alias), never caller identifiers. Google-derived matching and automatic background consumption remain deferred independently of any later core matching enablement.

Source-authored real-SQL integration cases accept both matchable and agent-private Google suggestions, preserve their profile readback/provenance, and inspect actual default matcher `World` inputs/indexes with a positive member-stated fact control. Further cases call the actual background age/bias readers, proving normal staff/chat controls still affect them while Google source facts do not. These cases have not been run; no migration, provider or matching activation occurred.


## Revoked connection cleanup route pair (source only)

Network receives the original exact signed body at `POST /internal/profile-suggestions/connection` with signature ID `connection-cleanup:<requestNonce>`. The existing optional profile-review factory now supplies `profileSuggestionRevokedOwner`; its bounded signed transport calls Cloud `POST /api/internal/network/profile-review-disconnect`, using the same signature ID and exact payload `{request, requestSha256}`. `requestSha256` hashes the original cleanup body, not the callback wrapper. Cloud must answer a signed `<id>:proof` response proving the current owner, app/member/person, actual revoked connection event, explicitly requested operation, immutable `revokedAt` and <=30-second validity. It must not require active OAuth source-read consent.

The service dispatches this exact path before its generic suggestion prefix. Without an explicit callback/configured route it returns unavailable. Cleanup uses a dedicated `ProfileSuggestions` instance whose active-source authorization always returns false. Its owner callback refreshes the revoked-owner proof inside the SQL transaction and after mutation, requiring all original owner/event/operation/cutoff bindings and current route/expiry fences. No other source resolver can authorize this path.

The storage owner supplies `applyRevokedConnection(owner, request, proof, fence)` and migration `0040_profile_suggestion_connection_receipts.sql`: atomic replay receipt plus cutoff-limited disconnect/delete/count readback. Integration source now exercises actual SQL and the actual service route with only the external Cloud proof faked, including replay, owner/event/cutoff/expiry rollback, retention/delete and preservation of batches created after revocation. These cases have not been executed. Cloud counterpart, schema integration and deployed end-to-end cleanup are still required; there is no new default enablement.

## Paired timing corrections

Every signed membership/entry proof now returns `collectionExpiresAt`, derived from the exact stored Network `platform.inbound.arrived_at + 24h`. Its existing `expiresAt` remains the short proof lifetime (at most 30 seconds). Cloud must use the signed collection deadline for the selection DTO rather than its local admission time. The strict proof parser rejects a missing/overlong collection deadline and a selected DTO with a different deadline.

`SourceSuggestion.observedAt` preserves source time: Gmail message time must not be in the future; Calendar event start may be in the future when it falls inside the explicit selected window. Both kinds remain in the half-open selected interval `[windowStart, windowEnd)`. No timestamp is replaced with collection time.

These are source changes with SQL integration cases authored, not executed acceptance. The exact Cloud durable origin for `revokedEventId` still needs confirmation before paired cleanup can be called ready.


## V2 intake withdrawal is separate from OAuth disconnect (source only)

The new optional callback is `profileSuggestionWithdrawalOwner`. Network receives `POST /internal/profile-suggestions/withdrawal`; the factory calls Cloud `POST /api/internal/network/profile-review-withdrawal` with `{request, requestSha256}` and HMAC ID `learning-withdrawal:<requestNonce>` (reply adds `:proof`). Request fields are exactly version 2, operation `withdraw|delete|readback`, app, personId, memberId, connectionId, withdrawalId and requestNonce. Proof fields add purpose `network-profile-review-withdrawal-v2`, original request hash, owner tuple, top-level channel/messageId/commandSha256, immutable cutoffAt, issuedAt and expiresAt. There is no `messageContext`, batchId or OAuth `connectionState` in this contract.

Cloud must bind its actual canonical owner command to the existing append-only primary `auth_events` receipt and clear the learning consent in the same transaction for withdraw/delete. Its stable event timestamp supplies cutoffAt, never retry time. Readback is count-only and must not create a withdrawal event or change consent/data. Network checks the actual stored completed inbound message SHA and current route, then reuses that inbound row's action receipts atomically with mutation; no V2 replay table or migration is added. No new withdrawal command grammar is imposed by this transport, and existing explicit per-batch deletion remains unchanged.

Withdrawal removes pending intake only, retaining accepted facts regardless of the legacy retain-on-disconnect flag. Explicit delete removes only scoped facts/suggestions at or before cutoff; later/reconnected batches survive. The dedicated store uses active-source authorization false and refreshes the V2 proof before and after mutation, requiring immutable cutoff, message scope, owner and operation. V1 remains a distinct, deferred actual OAuth-revocation contract and is never relabelled as V2 withdrawal. Google-derived matching/background use remains deferred.

The new integration source uses actual SQL/service routes and a synthetic external Cloud proof only, checking retention, explicit delete, readback non-mutation, original-message/route/owner/cutoff joins, replay across turns, expiry rollback and V1 rejection. No tests, Cloud requests, database actions, commits or deployment were run while authoring it.
