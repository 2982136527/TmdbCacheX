-- CreateTable
CREATE TABLE "ApiLog" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "type" TEXT,
    "source" TEXT,
    "hit" BOOLEAN NOT NULL,
    "ip" TEXT,
    "ua" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
