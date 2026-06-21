import axios from 'axios';
import { config } from './config.js';
// Configuration
const PROXY_URL = 'http://localhost:3333';
const API_KEY = config.tmdb.apiKey;
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function prefetchPopularMovies(pagesToFetch = 5) {
    console.log(`Starting prefetch for top ${pagesToFetch} pages of popular movies...`);
    for (let page = 1; page <= pagesToFetch; page++) {
        console.log(`\n--- Processing Page ${page} ---`);
        try {
            // 1. Get the list of movies on this page
            // We use the PROXY_URL so even this list gets cached!
            const listUrl = `${PROXY_URL}/3/movie/popular?api_key=${API_KEY}&page=${page}`;
            const { data } = await axios.get(listUrl);
            const movies = data.results;
            console.log(`Found ${movies.length} movies. Fetching details...`);
            // 2. Fetch details for each movie
            for (const movie of movies) {
                // Don't include append_to_response here; the proxy auto-enriches with the full set
                const detailsUrl = `${PROXY_URL}/3/movie/${movie.id}?api_key=${API_KEY}`;
                try {
                    await axios.get(detailsUrl);
                    console.log(`✅ Cached: [${movie.id}] ${movie.title}`);
                }
                catch (err) {
                    console.error(`❌ Failed: [${movie.id}] ${movie.title} - ${err.message}`);
                }
                // Be nice to the upstream API (even though we are caching, the first hit goes out)
                await delay(200);
            }
        }
        catch (err) {
            console.error(`Error fetching page ${page}:`, err.message);
        }
    }
    console.log('\nAll done!');
}
// Check for command line args for pages
const args = process.argv.slice(2);
const pages = args[0] ? parseInt(args[0]) : 3;
prefetchPopularMovies(pages);
//# sourceMappingURL=prefetch.js.map