-- Admin password recovery — Phase 4 database hardening.
--
-- Fixes found while auditing the Phase 1-3 recovery tables against a real
-- PostgreSQL 16 instance. No row is read, backfilled or deleted; the three
-- changes below only tighten constraints / widen one column.
--
-- 1. admin_passkeys.credentialId CHECK was unusable. PostgreSQL's regex
--    engine caps a bounded repetition at {n,255}; the original
--    '^[A-Za-z0-9_-]{1,1024}$' is accepted at CREATE TABLE time (the table
--    is empty, so the expression is never evaluated) but raises
--    "invalid regular expression: invalid repetition count(s)" on the FIRST
--    INSERT — i.e. every passkey registration would have failed. Replaced
--    with an unbounded '+' plus an explicit length bound.
ALTER TABLE "admin_passkeys" DROP CONSTRAINT "admin_passkeys_credentialId_format";
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_credentialId_format"
  CHECK (char_length("credentialId") BETWEEN 1 AND 1024 AND "credentialId" ~ '^[A-Za-z0-9_-]+$');

-- 2. The WebAuthn signature counter is an unsigned 32-bit integer (max
--    4,294,967,295). INTEGER tops out at 2,147,483,647, so a legitimate
--    authenticator that crosses 2^31 would make the counter UPDATE fail.
--    BIGINT holds the full range. (Prisma type: BigInt.)
ALTER TABLE "admin_passkeys" ALTER COLUMN "counter" TYPE BIGINT;
ALTER TABLE "admin_passkeys" ADD CONSTRAINT "admin_passkeys_counter_range"
  CHECK ("counter" BETWEEN 0 AND 4294967295);

-- 3. Short-lived artefacts must expire after they are created.
ALTER TABLE "admin_recovery_grants" ADD CONSTRAINT "admin_recovery_grants_expiry_after_create"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "admin_passkey_challenges" ADD CONSTRAINT "admin_passkey_challenges_expiry_after_create"
  CHECK ("expiresAt" > "createdAt");
ALTER TABLE "admin_recovery_challenges" ADD CONSTRAINT "admin_recovery_challenges_expiry_after_create"
  CHECK ("expiresAt" > "createdAt");
