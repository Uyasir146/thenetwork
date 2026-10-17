# Private suggestion review in the existing iMessage chat

This local source prepares the review interaction for the separately approved Google intake work. It does not read Google data, send messages, register a live route, or enable matching.

`profile-suggestion-review.ts` formats a pending batch and parses an explicit reply into an intent. Both operations require the server-bound Cloud user, organization, Network person, app and private chat to match. Batch revision, expiry and pending state must also match. A bare “yes” cannot accept a batch. Accepting an item requires choosing private or matching use. Editing returns an edit intent and requires a new preview before acceptance; rejecting grants no scope.

The Network-owned store must atomically revalidate the same identity, revision, expiry, source authorization and pending state. These parser checks are not an authorization substitute. Pending suggestions remain outside matching inputs; accepted facts retain source, observation time and inference provenance. Integration must use the store's canonical exported projection type rather than maintain a second definition.

Before live wiring, the store and adapter need their joined test, source-authorization check, displayed retention choice and normal dispatch registration. No client-supplied owner, model response, or parsed reply can supply the trusted identity. Retention/window choices and actual Google consent still precede any real collection.

Validation: Bun 1.4.2, eight tests and 37 assertions passed. Cases cover valid scoped acceptance, missing/ambiguous approval, wrong user/org/person/app/chat, stale batch or revision, expiry, edit without implicit acceptance, rejection, resolved batches and injected multiline instructions. Strict TypeScript checking of the module passed. No database, Google, model or provider calls were made. The earlier exploratory run used Bun 1.3.14 and is not the pinned result.
