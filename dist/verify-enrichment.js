import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();
const PROXY_URL = 'http://127.0.0.1:3333';
// Use a different movie to avoid cached data from previous runs (e.g. Inception)
const MOVIE_ID = 27205;
const API_KEY = process.env.TMDB_API_KEY;
async function verifyEnrichment() {
    console.log('--- 🧪 Verifying Auto-Enrichment ---');
    // Request WITHOUT append_to_response
    const url = `${PROXY_URL}/3/movie/${MOVIE_ID}?api_key=${API_KEY}`;
    console.log(`Fetching: ${url}`);
    try {
        const { data } = await axios.get(url);
        console.log(`\nChecking response for [${data.title}]...`);
        if (data.credits) {
            console.log('✅ Credits found! (Enrichment working)');
            console.log(`   Cast count: ${data.credits.cast.length}`);
        }
        else {
            console.error('❌ Credits MISSING! (Enrichment failed)');
        }
        if (data.images) {
            console.log('✅ Images found!');
            console.log(`   Backdrops: ${data.images.backdrops.length}`);
        }
        else {
            console.error('❌ Images MISSING!');
        }
        if (data.release_dates) {
            console.log('✅ Release Dates found!');
        }
    }
    catch (err) {
        console.error('❌ Request failed:', err.message);
    }
}
verifyEnrichment();
//# sourceMappingURL=verify-enrichment.js.map