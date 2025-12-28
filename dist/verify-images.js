import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function verifyImages() {
    try {
        console.log("🔍 Starting Cache Audit...");
        const allRecords = await prisma.tmdbCache.findMany();
        console.log(`📂 Total Cache Entries: ${allRecords.length}`);
        let movieCount = 0;
        let tvCount = 0;
        let withBackdrops = 0;
        let withoutBackdrops = 0;
        let missingIds = [];
        for (const record of allRecords) {
            // Check if it's a detail request (e.g., 3/movie/123 or 3/tv/456)
            // AND exclude things like /popular, /top_rated, /credits, etc.
            // Regex: 3/(movie|tv)/[NUMBER] ?...
            const match = record.url.match(/^3\/(movie|tv)\/(\d+)(\?|$)/);
            if (match) {
                const type = match[1]; // movie or tv
                const id = match[2];
                if (type === 'movie')
                    movieCount++;
                else
                    tvCount++;
                const data = JSON.parse(record.response);
                // Check if images exists and has backdrops
                if (data.images && Array.isArray(data.images.backdrops)) {
                    withBackdrops++;
                }
                else {
                    withoutBackdrops++;
                    missingIds.push(`${type}/${id}`);
                    // console.log(`❌ Missing images for: ${type}/${id} (${record.url})`);
                }
            }
        }
        console.log("------------------------------------------------");
        console.log(`🎬 Movies Scanned: ${movieCount}`);
        console.log(`📺 TV Shows Scanned: ${tvCount}`);
        console.log(`✅ Total Item Details: ${movieCount + tvCount}`);
        console.log("------------------------------------------------");
        console.log(`📸 With Backdrops Data: ${withBackdrops}`);
        console.log(`⚠️ Without Backdrops Data: ${withoutBackdrops}`);
        if (missingIds.length > 0) {
            console.log("\nSample items missing backdrops (First 10):");
            missingIds.slice(0, 10).forEach(id => console.log(` - ${id}`));
        }
        else {
            console.log("\n✨ PERFECT! All scanned items have image data.");
        }
    }
    catch (e) {
        console.error(e);
    }
    finally {
        await prisma.$disconnect();
    }
}
verifyImages();
//# sourceMappingURL=verify-images.js.map