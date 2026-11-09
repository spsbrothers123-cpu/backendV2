-- DropForeignKey
ALTER TABLE "purchase_items" DROP CONSTRAINT "purchase_items_productId_fkey";

-- AddForeignKey
ALTER TABLE "purchase_items" ADD CONSTRAINT "purchase_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
