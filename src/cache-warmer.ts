
import fs from 'fs';
import { handleTmdbRequest } from './proxy.js';
import dotenv from 'dotenv';
dotenv.config();

interface WarmerState {
    currentYear: number;
    lastCompletedPage: number;
    yearInProgress: boolean;
}

const CHECKPOINT_FILE = 'warmer_checkpoint.json';

/**
 * CacheWarmer
 * Actively triggers requests for popular/top-rated content to "warm up" the cache.
 */
export class CacheWarmer {
    private isRunning = false;
    private apiKey: string;

    constructor() {
        this.apiKey = process.env.TMDB_API_KEY || '';
        if (!this.apiKey) {
            console.warn('[WARMER] No API Key found. Warmer will not run.');
        }
    }

    public start() {
        if (this.isRunning || !this.apiKey) return;
        this.isRunning = true;

        console.log('[WARMER] 🚀 Cache Warmer started! (Dual-Engine: Updates & Archive)');

        // Start HOT loop (Updates)
        this.startHotLoop().catch(err => console.error(`[HOT-LOOP] Crash: ${err.message}`));

        // Start COLD loop (Archive)
        this.startColdLoop().catch(err => console.error(`[COLD-LOOP] Crash: ${err.message}`));
    }

    private async startHotLoop() {
        console.log('[HOT-LOOP] 🔥 Update Engine Started (Popular & Now Playing)');
        while (this.isRunning) {
            try {
                await this.runHotCrawl();
                console.log('[HOT-LOOP] ✅ Update cycle complete. Sleeping for 4 hours...');
                await new Promise(r => setTimeout(r, 4 * 3600 * 1000)); // 4 hours
            } catch (e) {
                console.error('[HOT-LOOP] Error:', e);
                await new Promise(r => setTimeout(r, 60 * 1000)); // Retry after minute if crash
            }
        }
    }

    private async startColdLoop() {
        console.log('[COLD-LOOP] 🧊 Archive Engine Started (Deep History Crawl)');
        // Just run the full crawl logic once (it takes forever anyway)
        // If it ever finishes, we could restart it or just stop.
        await this.runFullCrawl();
    }

    private async runHotCrawl() {
        const tasks = [
            { path: '3/movie/popular', maxPages: 20 },
            { path: '3/movie/now_playing', maxPages: 10 },
            { path: '3/tv/popular', maxPages: 10 },
            { path: '3/movie/top_rated', maxPages: 5 },
        ];

        for (const task of tasks) {
            console.log(`[HOT-LOOP] Checking updates for: ${task.path}`);
            for (let page = 1; page <= task.maxPages; page++) {
                if (!this.isRunning) break;
                const url = `${task.path}?api_key=${this.apiKey}&language=zh-CN&page=${page}`;
                try {
                    console.log(`[HOT-LOOP] Scanning page ${page} of ${task.path}...`);
                    await handleTmdbRequest(url, false);
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e: any) {
                    console.error(`[HOT-LOOP] Failed page ${page}: ${e.message}`);
                }
            }
        }
    }

    // --- CHECKPOINTING LOGIC ---

    private saveCheckpoint(year: number, page: number) {
        const state: WarmerState = {
            currentYear: year,
            lastCompletedPage: page,
            yearInProgress: true
        };
        try {
            fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(state));
        } catch (e) {
            // ignore write error
        }
    }

    private loadCheckpoint(): WarmerState | null {
        try {
            if (fs.existsSync(CHECKPOINT_FILE)) {
                return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
            }
        } catch (e) { }
        return null;
    }

    private async runFullCrawl() {
        // Strategy: Iterate by Year to bypass 500-page limit and cover everything.
        const currentYear = new Date().getFullYear() + 1; // +1 to cover upcoming
        const startYear = 1880;

        // LOAD CHECKPOINT
        const state = this.loadCheckpoint();
        let loopStartYear = currentYear;

        // If we have a valid state, resume from there
        if (state && state.yearInProgress && state.currentYear <= currentYear) {
            loopStartYear = state.currentYear;
            console.log(`[WARMER] ♻️ Resuming from checkpoint: Year ${state.currentYear}, Page ${state.lastCompletedPage}`);
        }

        for (let year = loopStartYear; year >= startYear; year--) {
            if (!this.isRunning) break;
            console.log(`[WARMER] 📅 Starting Full Crawl for Year: ${year}`);

            // Resume logic: if this is the resumed year, start page is checkpoint + 1.
            // else start page is 1.
            const startPage = (state && year === state.currentYear) ? state.lastCompletedPage + 1 : 1;

            // Movies
            await this.crawlDiscover('3/discover/movie', { primary_release_year: year.toString() }, startPage, year);

            // TV Shows
            // For simplicity, we don't checkpoint TV precisely in this version, just restart list for that year
            await this.crawlDiscover('3/discover/tv', { first_air_date_year: year.toString() }, 1, year);
        }

        console.log('[WARMER] 🎉 UNBELIEVABLE! You have crawled the entire known universe of TMDB!');
    }

    private async crawlDiscover(endpoint: string, params: Record<string, string>, startPage = 1, currentYearForCheckpoint: number) {
        const urlParams = new URLSearchParams(params);
        urlParams.set('api_key', this.apiKey);
        urlParams.set('language', 'zh-CN');
        // Sort by popularity desc to get most relevant first in that year
        urlParams.set('sort_by', 'popularity.desc');

        // TMDB max pages for discover is 500.
        const MAX_PAGES = 500;
        let consecutiveErrors = 0; // Initialize error counter

        for (let page = startPage; page <= MAX_PAGES; page++) {
            if (!this.isRunning) break;

            urlParams.set('page', page.toString());
            const url = `${endpoint}?${urlParams.toString()}`;

            try {
                // HACK: To be efficient, we need to inspect the response.
                // Since handleTmdbRequest returns the data, we can use it!
                console.log(`[WARMER] 🔍 Scanning ${endpoint} (Year ${params.primary_release_year || params.first_air_date_year}) - Page ${page}`);
                const data = await handleTmdbRequest(url.replace(/\?.*/, '') + '?' + urlParams.toString(), false);

                // Debug log to see what TMDB returned
                if (page === 1) {
                    console.log(`[DEBUG] Year ${params.primary_release_year || params.first_air_date_year} Total Pages: ${data?.total_pages}, Total Results: ${data?.total_results}`);
                }

                // Reset errors on success
                consecutiveErrors = 0;

                // SAVE CHECKPOINT (Only checkpoint on movie pages for this version's simplicity)
                if (endpoint.includes('movie')) {
                    this.saveCheckpoint(currentYearForCheckpoint, page);
                }

                if (data && data.total_pages && page >= data.total_pages) {
                    console.log(`[WARMER] Reached last page (${data.total_pages}) for this year.`);
                    break;
                }

                // Politeness delay
                await new Promise(r => setTimeout(r, 1500));
            } catch (e: any) {
                console.error(`[WARMER] Failed ${endpoint} page ${page}: ${e.message}`);

                // Log debug details if available
                if (e.response) {
                    console.error(`[DEBUG] Error Status: ${e.response.status}, Data: ${JSON.stringify(e.response.data)}`);
                }
                consecutiveErrors++;
                consecutiveErrors++;
                if (consecutiveErrors >= 5) {
                    console.error(`[WARMER] Too many consecutive errors (${consecutiveErrors}). Stopping for this year.`);
                    break;
                }
                // If 404 or 422, likely out of pages
                if (e.response && (e.response.status === 404 || e.response.status === 422)) {
                    console.warn(`[WARMER] Stopping this year due to status ${e.response.status}.`);
                    break;
                }
            }
        }
    }
}
