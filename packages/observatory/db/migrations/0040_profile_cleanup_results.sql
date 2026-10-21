-- Preserve the original completed V1 result for exact, authenticated retry reconciliation.
-- Existing receipts remain NULL: completion alone cannot reconstruct an earlier response.
-- SELECT/INSERT grants from 0039 cover the added column; no UPDATE privilege is added.
alter table platform.profile_suggestion_connection_receipts add column if not exists result jsonb;
