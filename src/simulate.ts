
import axios from 'axios';
import { config } from './config.js';

const PROXY_URL = 'http://127.0.0.1:3333';
const API_KEY = config.tmdb.apiKey || process.argv[2];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url: string, retries = 5, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(url);
        } catch (err: any) {
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

    // 1. Search for a movie (e.g., "The Matrix")
    const searchQuery = 'The Matrix';
    console.log(`\n🔍 Step 1: Searching for "${searchQuery}"...`);

    try {
        const searchUrl = `${PROXY_URL}/3/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(searchQuery)}`;
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
        const detailsUrl = `${PROXY_URL}/3/movie/${movie.id}?api_key=${API_KEY}&language=${config.tmdb.language}`;
        const detailsRes = await fetchWithRetry(detailsUrl);

        const details = detailsRes?.data;
        console.log(`✅ Got Details!`);
        console.log(`   Title: ${details.title}`);
        console.log(`   Tagline: ${details.tagline}`);
        console.log(`   Runtime: ${details.runtime} mins`);
        console.log(`   Poster Path: ${details.poster_path}`);

        console.log('\n✨ Simulation Complete. Data was served via Local Proxy.');

    } catch (err: any) {
        if (err.response) {
            console.error(`❌ HTTP Error: ${err.response.status} ${err.response.statusText}`);
            console.error(`   Message: ${JSON.stringify(err.response.data)}`);
            if (err.response.status === 401) {
                console.log('\n💡 Tip: You likely need to provide a valid TMDB API Key in config.json.');
            }
        } else {
            console.error('Full Error Object:', err);
            console.error('❌ Network/Script Error:', err.message);
        }
    }
}

simulateScrape();
