import fs from 'fs';
import { handleTmdbRequest } from './proxy.js';
import { config } from './config.js';
const CHECKPOINT_FILE = 'warmer_checkpoint.json';
/**
 * CacheWarmer
 * Actively triggers requests for popular/top-rated content to "warm up" the cache.
 */
export class CacheWarmer {
    isRunning = false;
    apiKey;
    constructor() {
        this.apiKey = config.tmdb.apiKey;
    }
    start() {
        if (this.isRunning || !this.apiKey)
            return;
        this.isRunning = true;
        console.log('[WARMER] 🚀 Cache Warmer started! (Dual-Engine: Updates & Archive)');
        // Start HOT loop (Updates)
        this.startHotLoop().catch(err => console.error(`[HOT-LOOP] Crash: ${err.message}`));
        // Start COLD loop (Archive)
        this.startColdLoop().catch(err => console.error(`[COLD-LOOP] Crash: ${err.message}`));
    }
    stop() {
        this.isRunning = false;
    }
    async startHotLoop() {
        console.log('[HOT-LOOP] 🔥 Update Engine Started (Popular & Now Playing)');
        while (this.isRunning) {
            try {
                await this.runHotCrawl();
                console.log('[HOT-LOOP] ✅ Update cycle complete. Sleeping for 4 hours...');
                await new Promise(r => setTimeout(r, 4 * 3600 * 1000)); // 4 hours
            }
            catch (e) {
                console.error('[HOT-LOOP] Error:', e);
                await new Promise(r => setTimeout(r, 60 * 1000)); // Retry after minute if crash
            }
        }
    }
    async startColdLoop() {
        console.log('[COLD-LOOP] 🧊 Archive Engine Started (Deep History Crawl)');
        while (this.isRunning) {
            try {
                await this.runFullCrawl();
                console.log('[COLD-LOOP] ✅ Full crawl cycle complete. Restarting...');
            }
            catch (e) {
                console.error('[COLD-LOOP] Error:', e);
                await new Promise(r => setTimeout(r, 60 * 1000));
            }
        }
    }
    async runHotCrawl() {
        const tasks = [
            // Movies
            { path: '3/movie/popular', maxPages: 20 },
            { path: '3/movie/now_playing', maxPages: 10 },
            { path: '3/movie/top_rated', maxPages: 5 },
            { path: '3/movie/upcoming', maxPages: 5 },
            // TV Shows
            { path: '3/tv/popular', maxPages: 10 },
            { path: '3/tv/top_rated', maxPages: 5 },
            { path: '3/tv/on_the_air', maxPages: 5 },
            { path: '3/tv/airing_today', maxPages: 3 },
            // Trending
            { path: '3/trending/all/day', maxPages: 10 },
            { path: '3/trending/movie/week', maxPages: 5 },
            { path: '3/trending/tv/week', maxPages: 5 },
        ];
        // Resume from checkpoint if available
        const state = this.loadCheckpoint();
        const startTaskIdx = (state?.hotLoopTaskIndex != null) ? state.hotLoopTaskIndex : 0;
        const startPageIdx = (state?.hotLoopPageIndex != null) ? state.hotLoopPageIndex : 0;
        for (let ti = startTaskIdx; ti < tasks.length; ti++) {
            const task = tasks[ti];
            const startPage = (ti === startTaskIdx) ? startPageIdx + 1 : 1;
            console.log(`[HOT-LOOP] Checking updates for: ${task.path}`);
            for (let page = startPage; page <= task.maxPages; page++) {
                if (!this.isRunning)
                    break;
                const url = `${task.path}?api_key=${this.apiKey}&language=${config.tmdb.language}&page=${page}`;
                try {
                    console.log(`[HOT-LOOP] Scanning page ${page} of ${task.path}...`);
                    await handleTmdbRequest(url, true);
                    this.saveHotLoopCheckpoint(ti, page);
                    await new Promise(r => setTimeout(r, 2000));
                }
                catch (e) {
                    console.error(`[HOT-LOOP] Failed page ${page}: ${e.message}`);
                }
            }
        }
        // Clear hot loop checkpoint after full cycle
        this.clearHotLoopCheckpoint();
    }
    // --- CHECKPOINTING LOGIC ---
    saveCheckpoint(year, page) {
        const existing = this.loadCheckpoint();
        const state = {
            currentYear: year,
            lastCompletedPage: page,
            ...(existing?.lastCompletedTvPage != null ? { lastCompletedTvPage: existing.lastCompletedTvPage } : {}),
            yearInProgress: true,
        };
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(state));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        }
        catch (e) {
            // ignore write error
        }
    }
    saveTvCheckpoint(year, page) {
        const existing = this.loadCheckpoint();
        const state = {
            currentYear: year,
            lastCompletedPage: existing?.lastCompletedPage ?? 0,
            ...(page > 0 ? { lastCompletedTvPage: page } : {}),
            yearInProgress: true,
        };
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(state));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        }
        catch (e) {
            // ignore write error
        }
    }
    saveHotLoopCheckpoint(taskIndex, pageIndex) {
        const existing = this.loadCheckpoint();
        const state = {
            currentYear: existing?.currentYear ?? new Date().getFullYear() + 1,
            lastCompletedPage: existing?.lastCompletedPage ?? 0,
            yearInProgress: existing?.yearInProgress ?? false,
            hotLoopTaskIndex: taskIndex,
            hotLoopPageIndex: pageIndex,
        };
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(state));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        }
        catch (e) {
            // ignore write error
        }
    }
    clearHotLoopCheckpoint() {
        const existing = this.loadCheckpoint();
        if (!existing)
            return;
        delete existing.hotLoopTaskIndex;
        delete existing.hotLoopPageIndex;
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(existing));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        }
        catch (e) { }
    }
    loadCheckpoint() {
        try {
            if (fs.existsSync(CHECKPOINT_FILE)) {
                return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
            }
        }
        catch (e) { }
        return null;
    }
    async runFullCrawl() {
        const currentYear = new Date().getFullYear() + 1; // +1 to cover upcoming
        const startYear = 1880;
        // LOAD CHECKPOINT
        const state = this.loadCheckpoint();
        // Always start from currentYear; only use checkpoint for the starting page within that year
        if (state && state.yearInProgress) {
            console.log(`[WARMER] ♻️ Resuming from checkpoint: Year ${state.currentYear}, Page ${state.lastCompletedPage}`);
        }
        for (let year = currentYear; year >= startYear; year--) {
            if (!this.isRunning)
                break;
            console.log(`[WARMER] 📅 Starting Full Crawl for Year: ${year}`);
            // Resume logic: if this is the resumed year, start page is checkpoint + 1.
            // else start page is 1.
            const startPage = (state && year === state.currentYear && state.yearInProgress) ? state.lastCompletedPage + 1 : 1;
            // Movies
            await this.crawlDiscover('3/discover/movie', { primary_release_year: year.toString() }, startPage, year, false);
            // TV Shows (use tvStartPage for resumed year, otherwise 1)
            const tvStartPage = (state && year === state.currentYear && state.yearInProgress) ? (state.lastCompletedTvPage || 1) : 1;
            await this.crawlDiscover('3/discover/tv', { first_air_date_year: year.toString() }, tvStartPage, year, true);
        }
        console.log('[WARMER] 🎉 UNBELIEVABLE! You have crawled the entire known universe of TMDB!');
    }
    async crawlDiscover(endpoint, params, startPage = 1, currentYearForCheckpoint, isTv = false) {
        const urlParams = new URLSearchParams(params);
        urlParams.set('api_key', this.apiKey);
        urlParams.set('language', config.tmdb.language);
        urlParams.set('sort_by', 'popularity.desc');
        const MAX_PAGES = 500;
        let consecutiveErrors = 0;
        for (let page = startPage; page <= MAX_PAGES; page++) {
            if (!this.isRunning)
                break;
            urlParams.set('page', page.toString());
            const url = `${endpoint}?${urlParams.toString()}`;
            try {
                console.log(`[WARMER] 🔍 Scanning ${endpoint} (Year ${params.primary_release_year || params.first_air_date_year}) - Page ${page}`);
                const data = await handleTmdbRequest(url, true);
                if (page === 1) {
                    console.log(`[DEBUG] Year ${params.primary_release_year || params.first_air_date_year} Total Pages: ${data?.total_pages}, Total Results: ${data?.total_results}`);
                }
                // Reset errors on success
                consecutiveErrors = 0;
                // SAVE CHECKPOINT
                if (isTv) {
                    this.saveTvCheckpoint(currentYearForCheckpoint, page);
                }
                else {
                    this.saveCheckpoint(currentYearForCheckpoint, page);
                }
                if (data && data.total_pages && page >= data.total_pages) {
                    console.log(`[WARMER] Reached last page (${data.total_pages}) for this year.`);
                    break;
                }
                await new Promise(r => setTimeout(r, 1500));
            }
            catch (e) {
                console.error(`[WARMER] Failed ${endpoint} page ${page}: ${e.message}`);
                if (e.response) {
                    console.error(`[DEBUG] Error Status: ${e.response.status}, Data: ${JSON.stringify(e.response.data)}`);
                }
                consecutiveErrors++;
                if (consecutiveErrors >= 5) {
                    console.error(`[WARMER] Too many consecutive errors (${consecutiveErrors}). Stopping for this year.`);
                    break;
                }
                if (e.response && (e.response.status === 404 || e.response.status === 422)) {
                    console.warn(`[WARMER] Stopping this year due to status ${e.response.status}.`);
                    break;
                }
            }
        }
    }
}
//# sourceMappingURL=cache-warmer.js.map