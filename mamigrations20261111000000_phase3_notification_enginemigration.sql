warning: in the working copy of 'prisma/schema.prisma', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/prisma/schema.prisma b/prisma/schema.prisma[m
[1mindex eb145b7..ec8598e 100644[m
[1m--- a/prisma/schema.prisma[m
[1m+++ b/prisma/schema.prisma[m
[36m@@ -199,6 +199,9 @@[m [mmodel Shop {[m
   expenses         Expense[][m
   billCounters     BillCounter[][m
   notifications    Notification[][m
[32m+[m[32m  appNotifications AppNotification[][m
[32m+[m[32m  notificationSettings BranchNotificationSettings?[m
[32m+[m[32m  productLowStock  BranchProductLowStock[][m
   settings         ShopSettings?[m
   invitationCodes  InvitationCode[][m
 [m
[36m@@ -418,6 +421,11 @@[m [mmodel User {[m
   expensesCreated     Expense[][m
   creditTxnsActed     CreditTransaction[][m
 [m
[32m+[m[32m  appNotificationRecipients AppNotificationRecipient[][m
[32m+[m[32m  notificationPreferences   NotificationPreference[][m
[32m+[m[32m  announcementsCreated      Announcement[] @relation("AnnouncementCreator")[m
[32m+[m[32m  announcementsTargeted     Announcement[] @relation("AnnouncementTarget")[m
[32m+[m
   @@index([role, status])[m
   @@index([shopId])[m
   @@map("users")[m
[36m@@ -503,6 +511,7 @@[m [mmodel Product {[m
   branchProducts    BranchProduct[][m
   branchInventories BranchInventory[][m
   purchaseItems     PurchaseItem[][m
[32m+[m[32m  branchLowStock    BranchProductLowStock[][m
 [m
   @@index([shopId, status])[m
   @@index([shopId, category])[m
[36m@@ -1268,3 +1277,216 @@[m [mmodel CashierRecoveryRequest {[m
   @@index([ip, createdAt])[m
   @@map("cashier_recovery_requests")[m
 }[m
[32m+[m
[32m+[m
[32m+[m[32m// ═══════════════════════════════════════════════════════════════════════[m
[32m+[m[32m// BACKEND PHASE 3 — Notification engine (B3.1). ALL NEW TABLES (D-26): the[m
[32m+[m[32m// legacy `notifications` table / `Notification` model above is untouched.[m
[32m+[m[32m// ═══════════════════════════════════════════════════════════════════════[m
[32m+[m
[32m+[m[32menum NtfCategory {[m
[32m+[m[32m  INVENTORY[m
[32m+[m[32m  CASHIER[m
[32m+[m[32m  CREDIT[m
[32m+[m[32m  SALES_PURCHASES[m
[32m+[m[32m  SECURITY[m
[32m+[m[32m  DAILY_SUMMARY[m
[32m+[m[32m  SESSION[m
[32m+[m[32m  ACCOUNT_SECURITY[m
[32m+[m[32m  ANNOUNCEMENT[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32menum NtfSeverity {[m
[32m+[m[32m  INFO[m
[32m+[m[32m  WARNING[m
[32m+[m[32m  CRITICAL[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32menum NtfStockState {[m
[32m+[m[32m  OK[m
[32m+[m[32m  LOW[m
[32m+[m[32m  OUT[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32menum AnnouncementAudience {[m
[32m+[m[32m  ALL_CASHIERS[m
[32m+[m[32m  INDIVIDUAL[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32menum DailySummaryKind {[m
[32m+[m[32m  MAIN[m
[32m+[m[32m  SUPPLEMENTARY[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// One row per notification EVENT. `dedupeKey` is the database-backed[m
[32m+[m[32m// idempotency key: a retried/duplicated detector insert is a no-op.[m
[32m+[m[32m// Per-user state (read / acknowledged / deleted) lives on the recipient row.[m
[32m+[m[32mmodel AppNotification {[m
[32m+[m[32m  id        String          @id @default(uuid())[m
[32m+[m[32m  dedupeKey String          @unique[m
[32m+[m[32m  category  NtfCategory[m
[32m+[m[32m  type      String[m
[32m+[m[32m  severity  NtfSeverity     @default(INFO)[m
[32m+[m[32m  title     String[m
[32m+[m[32m  message   String[m
[32m+[m
[32m+[m[32m  shopId    String?[m
[32m+[m[32m  shop      Shop?           @relation(fields: [shopId], references: [id], onDelete: SetNull)[m
[32m+[m
[32m+[m[32m  targetKind  String?[m
[32m+[m[32m  targetId    String?[m
[32m+[m[32m  targetRoute String?[m
[32m+[m
[32m+[m[32m  announcementId String?[m
[32m+[m[32m  announcement   Announcement? @relation(fields: [announcementId], references: [id], onDelete: SetNull)[m
[32m+[m
[32m+[m[32m  createdAt DateTime @default(now())[m
[32m+[m[32m  // createdAt + 90 days (D-10). Deletion markers live exactly as long.[m
[32m+[m[32m  expiresAt DateTime[m
[32m+[m
[32m+[m[32m  recipients AppNotificationRecipient[][m
[32m+[m
[32m+[m[32m  @@index([shopId, createdAt])[m
[32m+[m[32m  @@index([expiresAt])[m
[32m+[m[32m  @@index([announcementId])[m
[32m+[m[32m  @@map("app_notifications")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Per-user delivery + state. readAt / acknowledgedAt are independent (D-11).[m
[32m+[m[32m// deletedAt is the deletion marker (kept until the notification expires, D-10).[m
[32m+[m[32mmodel AppNotificationRecipient {[m
[32m+[m[32m  id             String          @id @default(uuid())[m
[32m+[m[32m  notificationId String[m
[32m+[m[32m  notification   AppNotification @relation(fields: [notificationId], references: [id], onDelete: Cascade)[m
[32m+[m[32m  userId         String[m
[32m+[m[32m  user           User            @relation(fields: [userId], references: [id], onDelete: Cascade)[m
[32m+[m
[32m+[m[32m  // Copy of the event's createdAt so list/cursor queries use one index.[m
[32m+[m[32m  createdAt      DateTime[m
[32m+[m[32m  readAt         DateTime?[m
[32m+[m[32m  acknowledgedAt DateTime?[m
[32m+[m[32m  deletedAt      DateTime?[m
[32m+[m
[32m+[m[32m  @@unique([notificationId, userId])[m
[32m+[m[32m  @@index([userId, createdAt(sort: Desc), id])[m
[32m+[m[32m  @@map("app_notification_recipients")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Per-user, per-category on/off switch (D-27). Locked categories are[m
[32m+[m[32m// enforced in code and by the API; no row can switch them off.[m
[32m+[m[32mmodel NotificationPreference {[m
[32m+[m[32m  id        String      @id @default(uuid())[m
[32m+[m[32m  userId    String[m
[32m+[m[32m  user      User        @relation(fields: [userId], references: [id], onDelete: Cascade)[m
[32m+[m[32m  category  NtfCategory[m
[32m+[m[32m  enabled   Boolean     @default(true)[m
[32m+[m[32m  updatedAt DateTime    @default(now()) @updatedAt[m
[32m+[m
[32m+[m[32m  @@unique([userId, category])[m
[32m+[m[32m  @@map("notification_preferences")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Admin-composed announcements (D-21). Content is immutable once inserted[m
[32m+[m[32m// (DB trigger); corrections are a NEW row pointing at the one it supersedes.[m
[32m+[m[32mmodel Announcement {[m
[32m+[m[32m  id        String               @id @default(uuid())[m
[32m+[m[32m  title     String[m
[32m+[m[32m  body      String[m
[32m+[m[32m  audience  AnnouncementAudience[m
[32m+[m[32m  targetCashierId String?[m
[32m+[m[32m  targetCashier   User?          @relation("AnnouncementTarget", fields: [targetCashierId], references: [id], onDelete: SetNull)[m
[32m+[m[32m  requiresAcknowledgement Boolean @default(false)[m
[32m+[m
[32m+[m[32m  createdById String?[m
[32m+[m[32m  createdBy   User?    @relation("AnnouncementCreator", fields: [createdById], references: [id], onDelete: SetNull)[m
[32m+[m[32m  createdAt   DateTime @default(now())[m
[32m+[m
[32m+[m[32m  supersedesId  String?       @unique[m
[32m+[m[32m  supersedes    Announcement? @relation("AnnouncementRevision", fields: [supersedesId], references: [id], onDelete: SetNull)[m
[32m+[m[32m  supersededBy  Announcement? @relation("AnnouncementRevision")[m
[32m+[m[32m  supersededAt  DateTime?[m
[32m+[m
[32m+[m[32m  notifications AppNotification[][m
[32m+[m
[32m+[m[32m  @@index([createdAt])[m
[32m+[m[32m  @@map("announcements")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Branch-level notification configuration (D-17, D-18, D-19 overrides).[m
[32m+[m[32m// Every column is nullable: NULL = "use the global default".[m
[32m+[m[32mmodel BranchNotificationSettings {[m
[32m+[m[32m  id      String @id @default(uuid())[m
[32m+[m[32m  shopId  String @unique[m
[32m+[m[32m  shop    Shop   @relation(fields: [shopId], references: [id], onDelete: Cascade)[m
[32m+[m
[32m+[m[32m  // "HH:MM" in IST (D-18).[m
[32m+[m[32m  openingTime String?[m
[32m+[m[32m  closingTime String?[m
[32m+[m[32m  highValueSaleThreshold Decimal? @db.Decimal(12, 2)[m
[32m+[m[32m  largeCreditThreshold   Decimal? @db.Decimal(12, 2)[m
[32m+[m[32m  creditOverdueDays      Int?[m
[32m+[m
[32m+[m[32m  updatedById String?[m
[32m+[m[32m  updatedAt   DateTime @default(now()) @updatedAt[m
[32m+[m
[32m+[m[32m  @@map("branch_notification_settings")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Branch override of Product.lowStockThreshold (D-17).[m
[32m+[m[32mmodel BranchProductLowStock {[m
[32m+[m[32m  id        String  @id @default(uuid())[m
[32m+[m[32m  shopId    String[m
[32m+[m[32m  shop      Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)[m
[32m+[m[32m  productId String[m
[32m+[m[32m  product   Product @relation(fields: [productId], references: [id], onDelete: Cascade)[m
[32m+[m[32m  lowStockThreshold Int[m
[32m+[m[32m  updatedAt DateTime @default(now()) @updatedAt[m
[32m+[m
[32m+[m[32m  @@unique([shopId, productId])[m
[32m+[m[32m  @@map("branch_product_low_stock")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Last observed stock state per (branch, product): makes stock alerts fire[m
[32m+[m[32m// once per TRANSITION, and survive restarts (D-23, D-24).[m
[32m+[m[32mmodel NotificationStockState {[m
[32m+[m[32m  id        String        @id @default(uuid())[m
[32m+[m[32m  shopId    String[m
[32m+[m[32m  productId String[m
[32m+[m[32m  state     NtfStockState[m
[32m+[m[32m  seq       Int           @default(1)[m
[32m+[m[32m  updatedAt DateTime      @default(now()) @updatedAt[m
[32m+[m
[32m+[m[32m  @@unique([shopId, productId])[m
[32m+[m[32m  @@map("notification_stock_states")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Scheduler lock + sweep watermark, one row per job (D-24).[m
[32m+[m[32mmodel NotificationJobState {[m
[32m+[m[32m  key           String    @id[m
[32m+[m[32m  lockedBy      String?[m
[32m+[m[32m  lockedUntil   DateTime?[m
[32m+[m[32m  lastStartedAt DateTime?[m
[32m+[m[32m  lastSuccessAt DateTime?[m
[32m+[m[32m  lastError     String?[m
[32m+[m[32m  failureCount  Int       @default(0)[m
[32m+[m[32m  cursorAt      DateTime?[m
[32m+[m[32m  updatedAt     DateTime  @default(now()) @updatedAt[m
[32m+[m
[32m+[m[32m  @@map("notification_job_state")[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32m// Stored daily summaries (D-22). MAIN = 12 AM-10 PM IST (generated 10 PM);[m
[32m+[m[32m// SUPPLEMENTARY = 10 PM-12 AM IST (generated 12:05 AM next day).[m
[32m+[m[32mmodel DailySummary {[m
[32m+[m[32m  id           String           @id @default(uuid())[m
[32m+[m[32m  businessDate String[m
[32m+[m[32m  kind         DailySummaryKind[m
[32m+[m[32m  windowStart  DateTime[m
[32m+[m[32m  windowEnd    DateTime[m
[32m+[m[32m  generatedAt  DateTime         @default(now())[m
[32m+[m[32m  metrics      Json[m
[32m+[m[32m  branches     Json[m
[32m+[m
[32m+[m[32m  @@unique([businessDate, kind])[m
[32m+[m[32m  @@map("daily_summaries")[m
[32m+[m[32m}[m
