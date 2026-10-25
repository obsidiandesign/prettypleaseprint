-- Better Auth 1.7.3 took back the `account.issuer` column that 1.7.0–1.7.2
-- required (see 20260823154500_account_issuer). It no longer writes it, so the
-- NOT NULL made every insert into `account` fail: no one could register.
--
-- This follows the library's 1.7 upgrade guide. Relax the column, drop its
-- index, and go back to the 1.6 rule that (providerId, accountId) is unique.
-- The column is kept, nullable and unused, because dropping it is optional and
-- can't be undone. It can go in a later cleanup.
DROP INDEX IF EXISTS "account_issuer_accountId_key";
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");
