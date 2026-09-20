-- READ-ONLY. Run this first; it changes nothing.
-- Shows, for every cashier: which shop they are actually assigned to, what
-- they typed as "branch name" at signup (a hint of intent, NOT authoritative),
-- which admin minted the invite they used, and whether they have any history.
SELECT
  u.email,
  u.status,
  s.name                AS assigned_shop,
  u."branchName"        AS typed_branch_name,
  a.email               AS invite_created_by,
  ic."createdAt"        AS invite_created_at,
  (SELECT COUNT(*) FROM bills b            WHERE b."cashierId" = u.id) AS bills,
  (SELECT COUNT(*) FROM cashier_sessions c WHERE c."cashierId" = u.id) AS sessions,
  (SELECT COUNT(*) FROM customers cu       WHERE cu."cashierId" = u.id) AS customers,
  (SELECT COUNT(*) FROM cashier_inventories ci WHERE ci."cashierId" = u.id) AS stock_rows
FROM users u
LEFT JOIN shops s              ON s.id  = u."shopId"
LEFT JOIN invitation_codes ic  ON ic."usedByUserId" = u.id
LEFT JOIN users a              ON a.id  = ic."createdByAdminId"
WHERE u.role = 'CASHIER'
ORDER BY u."createdAt";

-- Which shops does each admin own, and which one is their ACTIVE shop right now?
-- (users."shopId" for an admin = active shop; this is what invites used to inherit.)
SELECT a.email AS admin, s.name AS shop, (a."shopId" = s.id) AS is_active_shop
FROM users a
JOIN admin_shop_links l ON l."adminId" = a.id
JOIN shops s            ON s.id = l."shopId"
WHERE a.role = 'ADMIN'
ORDER BY a.email, s.name;
