-- READ-ONLY. Lists every ADMIN account so you can pick the Central Admin id.
SELECT u.id,
       u.email,
       u.name,
       u.status,
       u."createdAt",
       (SELECT count(*) FROM admin_shop_links l WHERE l."adminId" = u.id)            AS linked_shops,
       (SELECT string_agg(s.name, ', ' ORDER BY s.name)
          FROM admin_shop_links l JOIN shops s ON s.id = l."shopId"
         WHERE l."adminId" = u.id)                                                    AS shops
FROM users u
WHERE u.role = 'ADMIN'
ORDER BY u."createdAt";
