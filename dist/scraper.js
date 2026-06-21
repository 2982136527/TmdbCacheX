import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { config } from './config.js';
const PROXY_URL = 'http://127.0.0.1:3333';
const API_KEY = config.tmdb.apiKey;
const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/original';
// Retry helper with HTTP status code support
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function fetchWithRetry(url, retries = 5, delayMs = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios.get(url);
        }
        catch (err) {
            const isNetworkError = !err.response && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET');
            const isRetryableHttp = err.response && [429, 502, 503, 504].includes(err.response.status);
            if ((isNetworkError || isRetryableHttp) && i < retries - 1) {
                const reason = isNetworkError ? err.code : `HTTP ${err.response.status}`;
                console.log(`⚠️  ${reason}. Retrying (${i + 1}/${retries})...`);
                await delay(delayMs * (i + 1)); // exponential backoff
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Failed after ${retries} retries: ${url}`);
}
async function scrapeDirectory(dirPath) {
    console.log(`\n📂 Scraping Directory: ${dirPath}`);
    if (!fs.existsSync(dirPath)) {
        console.error('❌ Directory does not exist!');
        return;
    }
    const folderName = path.basename(dirPath);
    console.log(`🔍 Searching for: "${folderName}"`);
    try {
        // 1. Search
        const searchUrl = `${PROXY_URL}/3/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(folderName)}&language=${config.tmdb.language}`;
        const searchRes = await fetchWithRetry(searchUrl);
        const results = searchRes?.data.results;
        if (!results || results.length === 0) {
            console.log('❌ No results found.');
            return;
        }
        const movie = results[0];
        console.log(`✅ Match Found: ${movie.title} (${movie.release_date?.substring(0, 4)}) [ID:${movie.id}]`);
        // 2. Get Full Details (Credits, Images, Release Dates)
        const detailsUrl = `${PROXY_URL}/3/movie/${movie.id}?api_key=${API_KEY}&language=${config.tmdb.language}&append_to_response=credits,images,release_dates,videos&include_image_language=zh,null`;
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
        // Extrafanart (up to 10 extra backdrops)
        if (details.images?.backdrops?.length > 1) {
            const extraDir = path.join(dirPath, 'extrafanart');
            if (!fs.existsSync(extraDir))
                fs.mkdirSync(extraDir);
            const extras = details.images.backdrops.slice(1, 11);
            let count = 0;
            for (const img of extras) {
                const target = path.join(extraDir, path.basename(img.file_path));
                await downloadImage(`${IMAGE_BASE_URL}${img.file_path}`, target);
                count++;
            }
            console.log(`🖼️  Saved ${count} extrafanarts.`);
        }
        console.log('🎉 Enhancement Complete!');
    }
    catch (err) {
        console.error('❌ Error scraping:', err.message);
    }
}
function generateNfo(movie) {
    const escape = (str) => str ? str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') : '';
    const safe = (val) => val != null ? val : '';
    const genres = movie.genres?.map((g) => `<genre>${escape(g.name)}</genre>`).join('\n    ') || '';
    const studios = movie.production_companies?.map((c) => `<studio>${escape(c.name)}</studio>`).join('\n    ') || '';
    const actors = movie.credits?.cast?.slice(0, 15).map((actor) => `
    <actor>
        <name>${escape(actor.name)}</name>
        <role>${escape(actor.character)}</role>
        <thumb>${actor.profile_path ? `${IMAGE_BASE_URL}${actor.profile_path}` : ''}</thumb>
        <order>${safe(actor.order)}</order>
    </actor>`).join('') || '';
    const directors = movie.credits?.crew?.filter((c) => c.job === 'Director').map((d) => `<director>${escape(d.name)}</director>`).join('\n    ') || '';
    const writers = movie.credits?.crew?.filter((c) => c.department === 'Writing').map((w) => `<writer>${escape(w.name)}</writer>`).join('\n    ') || '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
    <title>${escape(movie.title)}</title>
    <originaltitle>${escape(movie.original_title)}</originaltitle>
    <sorttitle>${escape(movie.title)}</sorttitle>
    <year>${movie.release_date?.substring(0, 4) || ''}</year>
    <releasedate>${safe(movie.release_date)}</releasedate>
    <rating>${safe(movie.vote_average)}</rating>
    <votes>${safe(movie.vote_count)}</votes>
    <plot>${escape(movie.overview)}</plot>
    <tagline>${escape(movie.tagline)}</tagline>
    <runtime>${safe(movie.runtime)}</runtime>
    <mpaa>${movie.adult ? 'XXX' : 'PG-13'}</mpaa>
    <id>${safe(movie.id)}</id>
    <tmdbid>${safe(movie.id)}</tmdbid>
    <imdbid>${safe(movie.imdb_id)}</imdbid>
    <language>${safe(movie.original_language)}</language>

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
async function downloadImage(url, filepath) {
    const writer = fs.createWriteStream(filepath);
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream'
        });
        response.data.pipe(writer);
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
            response.data.on('error', reject);
        });
    }
    catch (e) {
        writer.close();
        try {
            fs.unlinkSync(filepath);
        }
        catch { } // cleanup partial file
        throw e;
    }
}
const targetDir = process.argv[2];
if (targetDir) {
    scrapeDirectory(targetDir);
}
else {
    console.log('Usage: npx ts-node src/scraper.ts /path/to/movie_folder');
}
//# sourceMappingURL=scraper.js.map