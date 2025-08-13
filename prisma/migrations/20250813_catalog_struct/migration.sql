-- Category hierarchy
ALTER TABLE "Category"
  ADD COLUMN IF NOT EXISTS "parentId" TEXT;

ALTER TABLE "Category"
  ADD CONSTRAINT IF NOT EXISTS "Category_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Category"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "Category_parentId_idx" ON "Category"("parentId");

-- Product extra fields
ALTER TABLE "Product"
  ADD COLUMN IF NOT EXISTS "packageSize" TEXT,
  ADD COLUMN IF NOT EXISTS "pdfUrl"      TEXT;

-- ProductImage table
CREATE TABLE IF NOT EXISTS "ProductImage" (
  "id"         TEXT PRIMARY KEY,
  "productId"  TEXT NOT NULL,
  "url"        TEXT NOT NULL,
  "sortOrder"  INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT "ProductImage_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProductImage_productId_idx" ON "ProductImage"("productId");
CREATE INDEX IF NOT EXISTS "ProductImage_sortOrder_idx"  ON "ProductImage"("sortOrder");
