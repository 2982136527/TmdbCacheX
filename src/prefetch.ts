
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

// Configuration
const PROXY_URL = 'http://localhost:3333';
const API_KEY = process.env.TMDB_API_KEY;

if (!API_KEY) {
    console.error('Error: TMDB_API_KEY environment variable is required for prefetching.');
    console.error('Please add TMDB_API_KEY=your_key_here to your .env file');
    process.exit(1);
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function prefetchPopularMovies(pagesToFetch: number = 5) {
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
                const detailsUrl = `${PROXY_URL}/3/movie/${movie.id}?api_key=${API_KEY}&append_to_response=credits,images,videos`;

                try {
                    await axios.get(detailsUrl);
                    console.log(`✅ Cached: [${movie.id}] ${movie.title}`);
                } catch (err: any) {
                    console.error(`❌ Failed: [${movie.id}] ${movie.title} - ${err.message}`);
                }

                // Be nice to the upstream API (even though we are caching, the first hit goes out)
                await delay(200);
            }

        } catch (err: any) {
            console.error(`Error fetching page ${page}:`, err.message);
        }
    }
    console.log('\nAll done!');
}

// Check for command line args for pages
const args = process.argv.slice(2);
const pages = args[0] ? parseInt(args[0]) : 3;

prefetchPopularMovies(pages);
