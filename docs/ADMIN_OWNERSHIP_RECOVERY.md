# Admin ownership recovery (manual procedure)

**Use only when an Admin has NO working recovery method** — no registered passkey they can use and no unused emergency recovery code — and has forgotten the password. The application deliberately offers no way to reset such an account: there is no master password, no environment-variable override, no hidden endpoint and no e-mail link. Recovery is a **human, two-person, audited** operation performed directly on the database.

If the Admin still has a passkey or a code, send them to *Forgot password* instead; do not use this procedure.

## 1. Verify ownership (before touching anything)

Record a ticket id (e.g. `OWN-2026-001`) and have **two people** involved: an *operator* (has database owner access) and a separate *approver*. All of the following must be satisfied:

1. The request is made by the business owner **in person, or on a live video call**, showing government photo ID that matches the registered owner. A phone call, a chat message or an e-mail alone is never sufficient.
2. The approver independently confirms the person is the owner of the shop(s) (e.g. a business registration / GST document, or a call-back to a number recorded **before** this incident).
3. Check the target account and recent activity — it must be exactly one `ADMIN` that is `ACTIVE`, and nothing looks like an attack in progress:
   ```sql
   SELECT id, email, role, status FROM users WHERE email = '<admin email>';
   SELECT event, outcome, method, ip, "createdAt" FROM admin_recovery_audit
    WHERE "userId" = '<id>' ORDER BY "createdAt" DESC LIMIT 50;
   ```
   If there are many recent `FAILURE` rows or a `PASSWORD_RECOVERED` the owner doesn't recognise, **stop** and treat it as a possible takeover.

## 2. Generate a one-time temporary password (operator, on a trusted machine, from `backend/`)

```bash
node -e "const b=require('bcryptjs');const c=require('crypto');const p=c.randomBytes(12).toString('base64url')+'a1';b.hash(p,12).then(h=>{console.log('TEMP PASSWORD (show once):',p);console.log('HASH:',h)})"
```

It satisfies the password policy. Never paste the temporary password into the ticket, chat or the database — only the **hash** goes into SQL.

## 3. Apply the change in ONE transaction

Connect with the database owner role (not the app's credentials) and run, substituting the email, hash and ticket details. Review the output of the first `SELECT` — it must return exactly one row — before committing.

```sql
BEGIN;

SELECT id, email, role, status FROM users
 WHERE email = '<admin email>' AND role = 'ADMIN' AND status = 'ACTIVE' FOR UPDATE;   -- exactly 1 row

UPDATE users SET "passwordHash" = '<bcrypt hash from step 2>', "updatedAt" = now()
 WHERE email = '<admin email>' AND role = 'ADMIN' AND status = 'ACTIVE';

-- Ownership of the old recovery methods is unknown, so retire them all; the Admin re-enrols afterwards.
UPDATE sessions SET "revokedAt" = now()
 WHERE "userId" = (SELECT id FROM users WHERE email = '<admin email>') AND "revokedAt" IS NULL;
UPDATE admin_recovery_codes SET "revokedAt" = now()
 WHERE "userId" = (SELECT id FROM users WHERE email = '<admin email>') AND "usedAt" IS NULL AND "revokedAt" IS NULL;
DELETE FROM admin_passkeys
 WHERE "userId" = (SELECT id FROM users WHERE email = '<admin email>');
UPDATE admin_recovery_grants SET "consumedAt" = now()
 WHERE "userId" = (SELECT id FROM users WHERE email = '<admin email>') AND "consumedAt" IS NULL;

INSERT INTO admin_recovery_audit (id, "userId", event, outcome, metadata)
SELECT gen_random_uuid()::text, id, 'MANUAL_OWNERSHIP_RECOVERY', 'SUCCESS',
       '{"ticket":"<ticket id>","operator":"<name>","approver":"<name>"}'::jsonb
  FROM users WHERE email = '<admin email>';

COMMIT;   -- or ROLLBACK if anything above looked wrong
```

## 4. Hand over and close out

1. Give the Admin the temporary password **in person or on the live call**, over a different channel from the one used to request recovery. Never by e-mail or message.
2. The Admin signs in and **immediately changes the password** (Admin → Profile), then opens *Security Settings*, generates a new set of recovery codes and (optionally) registers a passkey. Until then the temporary password is the only protection — do not leave it outstanding.
3. Confirm the audit row exists and the Admin can sign in; send a short note to the e-mail on file saying the password was reset manually (ticket id only — no credentials).
4. Close the ticket with: who verified, how, when, and the hash-generation machine used. Securely delete the temporary password from the operator's terminal/history.

## Never

- Never add a code path, flag, endpoint or "support password" that skips this procedure.
- Never reset a password without two people and verified ID.
- Never reuse a temporary password, store it, or send it in writing.
