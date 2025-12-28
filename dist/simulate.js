import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();
const PROXY_URL = 'http://127.0.0.1:3333';
// Allow passing key via env or arg
const API_KEY = process.env.TMDB_API_KEY || process.argv[2];
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function fetchWithRetry(url, retries = 5, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(url);
        }
        catch (err) {
            const isNetworkError = !err.response && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
            if (isNetworkError && i < retries - 1) {
                console.log(`⚠️  Connection failed (${err.code}). Server might be restarting... Retrying in ${delayMs / 1000}s (${i + 1}/${retries})`);
                await delay(delayMs);
                continue;
            }
            throw err;
        }
    }
}
async function simulateScrape() {
    console.log('--- 🎬 Simulating Scraper ---');
    console.log(`Using Proxy: ${PROXY_URL}`);
    if (!API_KEY) {
        console.error('⚠️  No API Key found.');
        console.error('   Please run with: TMDB_API_KEY=your_key npm run simulate');
        // We will continue anyway to show the proxy handling the 401
    }
    // 1. Search for a movie (e.g., "The Matrix")
    const searchQuery = 'The Matrix';
    console.log(`\n🔍 Step 1: Searching for "${searchQuery}"...`);
    try {
        const searchUrl = `${PROXY_URL}/3/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(searchQuery)}`;
        // Use retry here
        const searchRes = await fetchWithRetry(searchUrl);
        const results = searchRes?.data.results;
        if (!results || results.length === 0) {
            console.log('No results found (or invalid response).');
            return;
        }
        const movie = results[0];
        console.log(`✅ Found: ${movie.title} (ID: ${movie.id})`);
        console.log(`   Overview: ${movie.overview.substring(0, 60)}...`);
        // 2. Fetch Details (simulating scraping metadata)
        console.log(`\n📄 Step 2: Fetching details for ID ${movie.id}...`);
        const detailsUrl = `${PROXY_URL}/3/movie/${movie.id}?api_key=${API_KEY}&language=zh-CN`;
        const detailsRes = await fetchWithRetry(detailsUrl);
        const details = detailsRes?.data;
        console.log(`✅ Got Details!`);
        console.log(`   Title: ${details.title}`);
        console.log(`   Tagline: ${details.tagline}`);
        console.log(`   Runtime: ${details.runtime} mins`);
        console.log(`   Poster Path: ${details.poster_path}`);
        console.log('\n✨ Simulation Complete. Data was served via Local Proxy.');
    }
    catch (err) {
        if (err.response) {
            console.error(`❌ HTTP Error: ${err.response.status} ${err.response.statusText}`);
            console.error(`   Message: ${JSON.stringify(err.response.data)}`);
            if (err.response.status === 401) {
                console.log('\n💡 Tip: You likely need to provide a valid TMDB API Key.');
            }
        }
        else {
            console.error('Full Error Object:', err);
            console.error('❌ Network/Script Error:', err.message);
        }
    }
}
simulateScrape();
//# sourceMappingURL=simulate.js.map