
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const PROXY_URL = 'http://127.0.0.1:3333';
const API_KEY = process.env.TMDB_API_KEY;
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original'; // Use original mostly

// Retry helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fetchWithRetry(url: string, retries = 5, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(url);
        } catch (err: any) {
            const isNetworkError = !err.response && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
            if (isNetworkError && i < retries - 1) {
                console.log(`⚠️  Connection failed (${err.code}). Retrying...`);
                await delay(delayMs);
                continue;
            }
            throw err;
        }
    }
}

async function scrapeDirectory(dirPath: string) {
    console.log(`\n📂 Scraping Directory: ${dirPath}`);

    if (!fs.existsSync(dirPath)) {
        console.error('❌ Directory does not exist!');
        return;
    }

    const folderName = path.basename(dirPath);
    console.log(`🔍 Searching for: "${folderName}"`);

    try {
        // 1. Search
        const searchUrl = `${PROXY_URL}/3/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(folderName)}&language=zh-CN`;
        const searchRes = await fetchWithRetry(searchUrl);
        const results = searchRes?.data.results;

        if (!results || results.length === 0) {
            console.log('❌ No results found.');
            return;
        }

        const movie = results[0];
        console.log(`✅ Match Found: ${movie.title} (${movie.release_date?.substring(0, 4)}) [ID:${movie.id}]`);

        // 2. Get Full Details (Credits, Images, Release Dates)
        // using append_to_response to get everything in one cached call
        const detailsUrl = `${PROXY_URL}/3/movie/${movie.id}?api_key=${API_KEY}&language=zh-CN&append_to_response=credits,images,release_dates,videos&include_image_language=zh,null`;

        const detailsRes = await fetchWithRetry(detailsUrl);
        const details = detailsRes?.data;

        // 3. Generate Rich NFO
        const nfoContent = generateNfo(details);
        const nfoPath = path.join(dirPath, 'movie.nfo');
        fs.writeFileSync(nfoPath, nfoContent);
        console.log(`📝 Wrote rich NFO: ${nfoPath}`);

        // 4. Download Assets

        // Poster
        if (details.poster_path) {
            await downloadImage(`${IMAGE_BASE_URL}${details.poster_path}`, path.join(dirPath, 'poster.jpg'));
            console.log('🖼️  Saved poster.jpg');
        }

        // Fanart (Backdrop)
        if (details.backdrop_path) {
            await downloadImage(`${IMAGE_BASE_URL}${details.backdrop_path}`, path.join(dirPath, 'fanart.jpg'));
            console.log('🖼️  Saved fanart.jpg');
        }

        // Extrafanart
        // Get up to 10 extra backdrops
        if (details.images?.backdrops?.length > 1) {
            const extraDir = path.join(dirPath, 'extrafanart');
            if (!fs.existsSync(extraDir)) fs.mkdirSync(extraDir);

            // Skip the first one (it's usually the main fanart)
            const extras = details.images.backdrops.slice(1, 11);
            let count = 0;
            for (const img of extras) {
                // Determine filename (e.g. image_id or just clean name)
                const filename = `fanart${count > 0 ? count + 1 : ''}.jpg`; // standard kodi naming or just use file
                // Better: keep original filename structure or just random
                const target = path.join(extraDir, path.basename(img.file_path));

                await downloadImage(`${IMAGE_BASE_URL}${img.file_path}`, target);
                count++;
            }
            console.log(`🖼️  Saved ${count} extrafanarts.`);
        }

        console.log('🎉 Enhancement Complete!');

    } catch (err: any) {
        console.error('❌ Error scraping:', err.message);
    }
}

function generateNfo(movie: any): string {
    const escape = (str: string) => str ? str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';

    // Genres
    const genres = movie.genres?.map((g: any) => `<genre>${escape(g.name)}</genre>`).join('\n    ') || '';

    // Studios (Production Companies)
    const studios = movie.production_companies?.map((c: any) => `<studio>${escape(c.name)}</studio>`).join('\n    ') || '';

    // Credits
    const actors = movie.credits?.cast?.slice(0, 15).map((actor: any) => `
    <actor>
        <name>${escape(actor.name)}</name>
        <role>${escape(actor.character)}</role>
        <thumb>${actor.profile_path ? `${IMAGE_BASE_URL}${actor.profile_path}` : ''}</thumb>
        <order>${actor.order}</order>
    </actor>`).join('') || '';

    const directors = movie.credits?.crew?.filter((c: any) => c.job === 'Director').map((d: any) => `<director>${escape(d.name)}</director>`).join('\n    ') || '';
    const writers = movie.credits?.crew?.filter((c: any) => c.department === 'Writing').map((w: any) => `<writer>${escape(w.name)}</writer>`).join('\n    ') || '';

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${escape(movie.title)}</title>
    <originaltitle>${escape(movie.original_title)}</originaltitle>
    <sorttitle>${escape(movie.title)}</sorttitle>
    <year>${movie.release_date?.substring(0, 4)}</year>
    <releasedate>${movie.release_date}</releasedate>
    <rating>${movie.vote_average}</rating>
    <votes>${movie.vote_count}</votes>
    <plot>${escape(movie.overview)}</plot>
    <tagline>${escape(movie.tagline)}</tagline>
    <runtime>${movie.runtime}</runtime>
    <mpaa>${movie.adult ? 'XXX' : 'PG-13'}</mpaa>
    <id>${movie.id}</id>
    <tmdbid>${movie.id}</tmdbid>
    <imdbid>${movie.imdb_id || ''}</imdbid>
    <language>${movie.original_language}</language>
    
    ${genres}
    ${studios}
    ${directors}
    ${writers}
    
    <art>
        <poster>${movie.poster_path ? `${IMAGE_BASE_URL}${movie.poster_path}` : ''}</poster>
        <fanart>${movie.backdrop_path ? `${IMAGE_BASE_URL}${movie.backdrop_path}` : ''}</fanart>
    </art>

    ${actors}
</movie>`;
}

async function downloadImage(url: string, filepath: string) {
    try {
        const writer = fs.createWriteStream(filepath);
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (e) {
        console.error(`Failed to download image ${url}`);
    }
}

const targetDir = process.argv[2];
if (targetDir) {
    scrapeDirectory(targetDir);
} else {
    console.log('Usage: npx ts-node src/scraper.ts /path/to/movie_folder');
}
