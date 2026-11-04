-- READ-ONLY production audits. Run both and share the output BEFORE Phase 4
-- (which adds the UPI payment-reference table / cashier QR). Neither
-- statement writes anything. Phase 3's migration does not depend on either.

-- 1) Cashier -> Admin ownership classification
SELECT u.id, u.email, u."shopId",
  ic."createdByAdminId" AS invite_admin,
  CASE
    WHEN ic."createdByAdminId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM admin_shop_links l JOIN users a ON a.id = l."adminId"
      WHERE l."adminId" = ic."createdByAdminId" AND l."shopId" = u."shopId"
        AND a.role = 'ADMIN' AND a.status = 'ACTIVE')
      THEN 'OK_INVITATION'
    WHEN ic."createdByAdminId" IS NOT NULL THEN 'AMBIGUOUS_INVITER_NOT_LINKED'
    WHEN (SELECT count(*) FROM admin_shop_links l JOIN users a ON a.id = l."adminId"
          WHERE l."shopId" = u."shopId" AND a.role = 'ADMIN' AND a.status = 'ACTIVE') = 1
      THEN 'OK_SOLE_ADMIN'
    WHEN (SELECT count(*) FROM admin_shop_links l JOIN users a ON a.id = l."adminId"
          WHERE l."shopId" = u."shopId" AND a.role = 'ADMIN' AND a.status = 'ACTIVE') = 0
      THEN 'AMBIGUOUS_NO_ADMIN'
    ELSE 'AMBIGUOUS_MULTI_ADMIN'
  END AS ownership
FROM users u
LEFT JOIN invitation_codes ic ON ic."usedByUserId" = u.id
WHERE u.role = 'CASHIER' AND u.status = 'ACTIVE'
ORDER BY ownership, u.email;

-- 2) Existing duplicate UPI references (case/whitespace-insensitive)
SELECT upper(trim(reference)) AS ref, count(*) AS n
FROM payments
WHERE method = 'UPI' AND reference IS NOT NULL AND trim(reference) <> ''
GROUP BY 1 HAVING count(*) > 1
ORDER BY n DESC;
