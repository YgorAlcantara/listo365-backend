-- Add sortOrder column to Product
ALTER TABLE "Product"
ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;
