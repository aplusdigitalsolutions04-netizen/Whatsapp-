-- CreateTable
CREATE TABLE "OrderSheet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "orderName" TEXT,
    "orderDate" DATETIME,
    "customerName" TEXT,
    "productName" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "amount" REAL,
    "currency" TEXT,
    "paymentType" TEXT,
    "primaryMobile" TEXT,
    "altMobileShopify" TEXT,
    "fullAddress" TEXT,
    "city" TEXT,
    "state" TEXT,
    "pinCode" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "deliveryStatus" TEXT,
    "returnStatus" TEXT,
    "tags" TEXT,
    "cancelledAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'Unfulfilled',
    "remarks" TEXT,
    "trackingNo" TEXT,
    "trackingCompany" TEXT,
    "dispatchDateShopify" DATETIME,
    "shippingCharge" REAL,
    "shopifyUpdatedAt" DATETIME,
    "syncedAt" DATETIME,
    "callDate" DATETIME,
    "employeeName" TEXT,
    "altMobile" TEXT,
    "landmark" TEXT,
    "addressConfirmed" TEXT,
    "codConfirmed" TEXT,
    "deliveryAvailable" TEXT,
    "customerWants" TEXT,
    "callStatus" TEXT,
    "finalDecision" TEXT,
    "employeeRemark" TEXT,
    "dispatchDate" DATETIME,
    "awb" TEXT,
    "deliveryCharges" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OrderSyncState" (
    "shop" TEXT NOT NULL PRIMARY KEY,
    "lastSyncAt" DATETIME,
    "lastFullSyncAt" DATETIME,
    "lastCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderSheet_shop_shopifyOrderId_key" ON "OrderSheet"("shop", "shopifyOrderId");
CREATE INDEX "OrderSheet_shop_status_idx" ON "OrderSheet"("shop", "status");
CREATE INDEX "OrderSheet_shop_orderDate_idx" ON "OrderSheet"("shop", "orderDate");
CREATE INDEX "OrderSheet_shop_shopifyUpdatedAt_idx" ON "OrderSheet"("shop", "shopifyUpdatedAt");
