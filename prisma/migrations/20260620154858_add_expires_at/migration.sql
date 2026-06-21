-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TmdbCache" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "url" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_TmdbCache" ("createdAt", "id", "response", "updatedAt", "url") SELECT "createdAt", "id", "response", "updatedAt", "url" FROM "TmdbCache";
DROP TABLE "TmdbCache";
ALTER TABLE "new_TmdbCache" RENAME TO "TmdbCache";
CREATE UNIQUE INDEX "TmdbCache_url_key" ON "TmdbCache"("url");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
