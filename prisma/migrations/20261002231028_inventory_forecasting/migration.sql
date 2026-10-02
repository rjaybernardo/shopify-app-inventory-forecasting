-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "lookbackDays" INTEGER NOT NULL DEFAULT 30,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 14,
    "safetyStockDays" INTEGER NOT NULL DEFAULT 7,
    "warningDays" INTEGER NOT NULL DEFAULT 14,
    "coverageDays" INTEGER NOT NULL DEFAULT 30,
    "alertLevel" TEXT NOT NULL DEFAULT 'REORDER',
    "remindAfterDays" INTEGER NOT NULL DEFAULT 7,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertEmail" TEXT,
    "smsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertPhone" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "lastSyncedAt" DATETIME,
    "lastOrderSyncAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SaleLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "orderedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InventorySnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "available" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "VariantForecast" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT NOT NULL,
    "sku" TEXT,
    "imageUrl" TEXT,
    "price" REAL NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL,
    "unitsSold" INTEGER NOT NULL,
    "velocity" REAL NOT NULL,
    "recentVelocity" REAL NOT NULL,
    "trend" REAL,
    "daysOfCover" REAL,
    "stockoutDate" DATETIME,
    "reorderPoint" INTEGER NOT NULL,
    "reorderByDate" DATETIME,
    "suggestedQty" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "alertedStatus" TEXT,
    "alertedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VariantSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "leadTimeDays" INTEGER,
    "safetyStockDays" INTEGER
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "items" TEXT NOT NULL,
    "delivered" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SaleLine_shop_variantId_orderedAt_idx" ON "SaleLine"("shop", "variantId", "orderedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SaleLine_shop_lineItemId_key" ON "SaleLine"("shop", "lineItemId");

-- CreateIndex
CREATE UNIQUE INDEX "InventorySnapshot_shop_variantId_day_key" ON "InventorySnapshot"("shop", "variantId", "day");

-- CreateIndex
CREATE INDEX "VariantForecast_shop_status_idx" ON "VariantForecast"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VariantForecast_shop_variantId_key" ON "VariantForecast"("shop", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantSetting_shop_variantId_key" ON "VariantSetting"("shop", "variantId");

-- CreateIndex
CREATE INDEX "Alert_shop_createdAt_idx" ON "Alert"("shop", "createdAt");
