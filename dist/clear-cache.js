import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function clearCache() {
    try {
        const { count } = await prisma.tmdbCache.deleteMany({});
        console.log(`✅ Cleared ${count} cache entries.`);
    }
    catch (e) {
        console.error(e);
    }
    finally {
        await prisma.$disconnect();
    }
}
clearCache();
//# sourceMappingURL=clear-cache.js.map