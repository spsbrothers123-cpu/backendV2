# Backend Notification API Contract (as implemented)

All paths under `/api`. JWT + DB-session auth (existing). Errors: `{ success:false, message, code }` (existing handler). Recipient/branch scope always comes from the verified token — **no client user/shop/cashier id is read**. Foreign/unknown ids → **404**.
Timestamps ISO-8601 UTC. Date filters are **IST** (`Asia/Kolkata`).

## Admin (Central Admin only → others `403 CENTRAL_ADMIN_REQUIRED`, unset id `503`)
| Verb + path | Notes |
|---|---|
| `GET /admin/notifications` | query: `status=unread\|read`, `category` (slug), `branchId` (**filter only**), `dateFrom`,`dateTo` (`YYYY-MM-DD`, inclusive IST), `page` (≥1), `pageSize` (≤100, default 20). → `{items,total,page,pageSize,unreadCount}`; `unreadCount` ignores filters/pages. Unknown category → empty page. |
| `GET /admin/notifications/unread-count` | → `{unreadCount}` |
| `GET /admin/notifications/:id` | → item |
| `PATCH /admin/notifications/:id/read` | body `{read:true\|false}` (default true) → **204** |
| `PATCH /admin/notifications/read-all` | → 204 |
| `DELETE /admin/notifications/:id` | → 204; **403 `NOTIFICATION_NOT_DELETABLE`** for Security |
| `POST /admin/notifications/clear-read` | → `{deletedCount}` (skips Security) |
| `GET /admin/notification-settings` | → `{categories:[{category,enabled,mutable}]}` (6 categories) |
| `PUT /admin/notification-settings` | body `{categories:[{category,enabled}]}`; `security:false` is **ignored** (stays on). Unknown category → 422. Returns saved settings. |
| `GET /admin/daily-summaries` , `GET /admin/daily-summaries/:id` | id = `YYYY-MM-DD` (main) or `YYYY-MM-DD-supplementary`. Fields per contract + `kind`. |
| `POST /admin/announcements` | `{title≤200, body≤5000, audience:"all"\|"individual", cashierId?, requiresAcknowledgement}` → 201 with delivery stats |
| `GET /admin/announcements`, `GET /admin/announcements/:id` | list (page/pageSize) / detail with pending-acknowledgement cashiers |
| `POST /admin/announcements/:id/revise` | publishes a **new** announcement superseding the old (409 if already revised). **No PUT/PATCH/DELETE exists.** |
| `GET/PUT /admin/notification-branch-settings/:shopId` | `openingTime`,`closingTime` (`HH:MM` IST), `highValueSaleThreshold`, `largeCreditThreshold`, `creditOverdueDays`; `null` = default |
| `PUT /admin/notification-branch-settings/:shopId/products/:productId/low-stock-threshold` | `{lowStockThreshold:int\|null}` (D-17 override) |

**Admin item:** `{id,category,type,severity,title,message,createdAt,time(legacy),read,readAt,branch:{id,name}|null,target:{kind,id,route}|null}`. `read` is derived from `readAt` (D-04). Categories: `inventory, cashier, credit, sales_purchases, security, daily_summary`. Types are dotted canonical names (e.g. `inventory.low_stock`).

## Cashier (`CASHIER` role; branch from token)
| Verb + path | Notes |
|---|---|
| `GET /notifications` | `limit≤50`, `cursor`, `status=all\|unread`, `category`, `from`,`to` (**`YYYY-MM-DD` = IST day**, or ISO instant; inclusive). → `{items,nextCursor,unreadCount}`. Bad/foreign-filter cursor → `400 INVALID_CURSOR`. |
| `GET /notifications/unread-count` | → `{unreadCount}` |
| `GET /notifications/:id` | → item |
| `PUT /notifications/:id/read-state` | `{read}` → `{notification,unreadCount}` (idempotent) |
| `DELETE /notifications/:id` | → `{id,unreadCount}`; `403 NOTIFICATION_NOT_DELETABLE` (Security, or announcement pending acknowledgement); repeat → 404 |
| `POST /notifications/:id/acknowledge` | optional `Idempotency-Key` (shape-checked); `409 ACKNOWLEDGEMENT_NOT_REQUIRED`; repeat returns the **original** `acknowledgedAt`; never changes `readAt` |
| `GET /notifications/settings` | 5 categories with `mutable` (+`mandatoryReason` for `account_security`) |
| `PATCH /notifications/settings` | `{categories:{slug:bool}}`; turning `account_security` off → `403 SETTING_NOT_MUTABLE`; unknown → 422 |

**Cashier item:** `{id,category,type,severity,title,message,createdAt,readAt,recipientCashierId,shopId,capabilities:{canDelete},target:{kind,id?}|null,announcement?:{id,audience,body,requiresAcknowledgement,acknowledgedAt}}`. Categories: `inventory, account_security, session, announcement, credit`. Types: `low_stock, out_of_stock, restocked, password_changed, account_changed, recovery_status, session_opened, session_closed, cash_mismatch, opening_reminder, closing_reminder, announcement, credit_overdue, credit_adjusted, credit_cleared`.

## Event matrix (who receives what)
| Event | Admin (central) | Cashier |
|---|---|---|
| Low / out / restocked | all branches | that branch's Cashier |
| High-value sale (≥₹5,000) | ✔ | ✘ (transaction alerts excluded) |
| Large credit (≥₹10,000 credit portion) | ✔ | ✘ |
| Credit overdue / adjusted / cleared | ✔ | **owning Cashier only** (D-14) |
| Session opened / closed | ✔ | the session's Cashier |
| Cash mismatch (any ≠ 0) | ✔ | the session's Cashier |
| Failed logins (5 in 10 min), admin password recovered, cashier recovery requested | ✔ (Security) | ✘ |
| Cashier signup pending | ✔ | ✘ |
| Password changed / account changed / recovery status | ✘ | the affected Cashier (`account_security`) |
| Opening / closing reminder | ✘ | that branch's Cashier |
| Announcement | ✘ (composer only) | targeted Cashiers |
| Daily summary (10 PM, 12:05 AM) | ✔ | ✘ |
