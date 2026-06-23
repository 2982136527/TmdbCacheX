
import fs from 'fs';
import { handleTmdbRequest, prisma } from './proxy.js';
import { config } from './config.js';

interface WarmerState {
    currentYear: number;
    lastCompletedPage: number;
    lastCompletedTvPage?: number | undefined;
    yearInProgress: boolean;
    hotLoopTaskIndex?: number | undefined;
    hotLoopPageIndex?: number | undefined;
}

const CHECKPOINT_FILE = 'warmer_checkpoint.json';

/**
 * CacheWarmer
 * Actively triggers requests for popular/top-rated content to "warm up" the cache.
 */
export class CacheWarmer {
    private isRunning = false;
    private apiKey = '';

    public start() {
        const apiKey = config.tmdb.apiKey;
        if (this.isRunning || !apiKey) return;
        this.apiKey = apiKey;
        this.isRunning = true;

        console.log('[WARMER] 🚀 Cache Warmer started! (Triple-Engine: Updates, Changes & Archive)');

        // Start HOT loop (Updates)
        this.startHotLoop().catch(err => console.error(`[HOT-LOOP] Crash: ${err.message}`));

        // Start CHANGES loop (Incremental sync)
        this.startChangesLoop().catch(err => console.error(`[CHANGES-LOOP] Crash: ${err.message}`));

        // Start EXPIRE loop (Refresh expired cache, only if TTL enabled)
        if (config.enableCacheTtl) {
            this.startExpireLoop().catch(err => console.error(`[EXPIRE-LOOP] Crash: ${err.message}`));
        }

        // Start COLD loop (Archive)
        this.startColdLoop().catch(err => console.error(`[COLD-LOOP] Crash: ${err.message}`));
    }

    public stop() {
        this.isRunning = false;
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

    private async startExpireLoop() {
        console.log('[EXPIRE-LOOP] 🔄 Expired Cache Refresh Started');
        while (this.isRunning && config.enableCacheTtl) {
            try {
                const count = await this.runExpireRefresh();
                // Adaptive interval: more pending = shorter wait, none = long wait
                const interval = count === 0 ? 12 * 3600 * 1000
                    : count >= 1000 ? 30 * 60 * 1000
                    : count >= 500 ? 1 * 3600 * 1000
                    : 6 * 3600 * 1000;
                const label = interval >= 3600000 ? (interval / 3600000) + 'h' : (interval / 60000) + 'min';
                console.log(`[EXPIRE-LOOP] ✅ Refresh complete. Sleeping for ${label} hours...`);
                await new Promise(r => setTimeout(r, interval));
            } catch (e) {
                console.error('[EXPIRE-LOOP] Error:', e);
                await new Promise(r => setTimeout(r, 60 * 1000));
            }
        }
    }

    private async runExpireRefresh(): Promise<number> {
        const now = Date.now();
        const expired = await prisma.tmdbCache.findMany({
            where: {
                expiresAt: { lt: new Date(now) },
                OR: [
                    { url: { contains: '/movie/' } },
                    { url: { contains: '/tv/' } },
                    { url: { contains: '/person/' } },
                ],
            },
            select: { url: true },
            orderBy: { expiresAt: 'asc' },
            take: 1000,
        });

        if (expired.length > 0) {
            console.log(`[EXPIRE-LOOP] Found ${expired.length} expired entries, refreshing...`);
            let refreshed = 0;
            for (const item of expired) {
                if (!this.isRunning) break;
                try {
                    await handleTmdbRequest(item.url, true);
                    refreshed++;
                    await new Promise(r => setTimeout(r, 500));
                } catch (e: any) {
                    console.error(`[EXPIRE-LOOP] Failed ${item.url}: ${e.message}`);
                }
            }
            console.log(`[EXPIRE-LOOP] ✅ Refreshed ${refreshed}/${expired.length} expired entries.`);
            return expired.length;
        }

        // No expired entries — proactively refresh entries expiring within 7 days
        const soon = new Date(now + 7 * 24 * 3600 * 1000);
        const pending = await prisma.tmdbCache.findMany({
            where: {
                expiresAt: { lt: soon, gt: new Date(now) },
                OR: [
                    { url: { contains: '/movie/' } },
                    { url: { contains: '/tv/' } },
                    { url: { contains: '/person/' } },
                ],
            },
            select: { url: true },
            orderBy: { expiresAt: 'asc' },
            take: 200,
        });

        if (pending.length === 0) {
            console.log('[EXPIRE-LOOP] No entries to refresh.');
            return 0;
        }

        console.log(`[EXPIRE-LOOP] Proactively refreshing ${pending.length} entries expiring within 7 days...`);
        let refreshed = 0;
        for (const item of pending) {
            if (!this.isRunning) break;
            try {
                await handleTmdbRequest(item.url, true);
                refreshed++;
                await new Promise(r => setTimeout(r, 1000));
            } catch (e: any) {
                console.error(`[EXPIRE-LOOP] Failed ${item.url}: ${e.message}`);
            }
        }
        console.log(`[EXPIRE-LOOP] ✅ Proactively refreshed ${refreshed}/${pending.length} entries.`);
        return 0; // Return 0 so it uses the long idle interval
    }

    private async startColdLoop() {
        console.log('[COLD-LOOP] 🧊 Archive Engine Started (Deep History Crawl)');
        while (this.isRunning) {
            try {
                await this.runFullCrawl();
                console.log('[COLD-LOOP] ✅ Full crawl cycle complete. Restarting...');
            } catch (e) {
                console.error('[COLD-LOOP] Error:', e);
                await new Promise(r => setTimeout(r, 60 * 1000));
            }
        }
    }

    private async startChangesLoop() {
        console.log('[CHANGES-LOOP] 🔄 Incremental Sync Engine Started');
        // Track last sync date to avoid redundant fetches
        let lastSyncDate = '';
        while (this.isRunning) {
            try {
                const today = new Date().toISOString().split('T')[0]!;
                if (today !== lastSyncDate) {
                    await this.runChangesSync();
                    lastSyncDate = today;
                }
                console.log('[CHANGES-LOOP] ✅ Changes sync complete. Sleeping for 6 hours...');
                await new Promise(r => setTimeout(r, 6 * 3600 * 1000));
            } catch (e) {
                console.error('[CHANGES-LOOP] Error:', e);
                await new Promise(r => setTimeout(r, 60 * 1000));
            }
        }
    }

    private async runChangesSync() {
        const endDate = new Date().toISOString().split('T')[0]!;
        const startDate = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split('T')[0]!;
        console.log(`[CHANGES-LOOP] 📋 Checking changes from ${startDate} to ${endDate}`);

        // Fetch changed movies and TV shows
        const [movieIds, tvIds] = await Promise.all([
            this.fetchChangedIds('3/movie/changes', startDate, endDate),
            this.fetchChangedIds('3/tv/changes', startDate, endDate),
        ]);

        const total = movieIds.length + tvIds.length;
        if (total === 0) {
            console.log('[CHANGES-LOOP] No changes detected.');
            return;
        }
        console.log(`[CHANGES-LOOP] Found ${movieIds.length} movies, ${tvIds.length} TV shows changed.`);

        // Refresh each changed item
        let refreshed = 0;
        for (const id of movieIds) {
            if (!this.isRunning) break;
            try {
                const url = `3/movie/${id}?api_key=${this.apiKey}&language=${config.tmdb.language}`;
                await handleTmdbRequest(url, true);
                refreshed++;
                await new Promise(r => setTimeout(r, 1000));
            } catch (e: any) {
                console.error(`[CHANGES-LOOP] Failed movie ${id}: ${e.message}`);
            }
        }
        for (const id of tvIds) {
            if (!this.isRunning) break;
            try {
                const url = `3/tv/${id}?api_key=${this.apiKey}&language=${config.tmdb.language}`;
                await handleTmdbRequest(url, true);
                refreshed++;
                await new Promise(r => setTimeout(r, 1000));
            } catch (e: any) {
                console.error(`[CHANGES-LOOP] Failed TV ${id}: ${e.message}`);
            }
        }
        console.log(`[CHANGES-LOOP] ✅ Refreshed ${refreshed}/${total} changed items.`);
    }

    private async fetchChangedIds(endpoint: string, startDate: string, endDate: string): Promise<number[]> {
        const ids: number[] = [];
        let page = 1;
        const maxPages = 50; // safety limit
        while (page <= maxPages) {
            if (!this.isRunning) break;
            const url = `${endpoint}?api_key=${this.apiKey}&start_date=${startDate}&end_date=${endDate}&page=${page}`;
            try {
                const data = await handleTmdbRequest(url, true);
                const results = data?.results || [];
                for (const item of results) {
                    if (item.id && !item.adult) ids.push(item.id);
                }
                if (page >= (data?.total_pages || 1)) break;
                page++;
                await new Promise(r => setTimeout(r, 500));
            } catch (e: any) {
                console.error(`[CHANGES-LOOP] Failed to fetch ${endpoint} page ${page}: ${e.message}`);
                break;
            }
        }
        return ids;
    }

    private async runHotCrawl() {
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
            const task = tasks[ti]!;
            const startPage = (ti === startTaskIdx) ? startPageIdx + 1 : 1;
            console.log(`[HOT-LOOP] Checking updates for: ${task.path}`);
            for (let page = startPage; page <= task.maxPages; page++) {
                if (!this.isRunning) break;
                const url = `${task.path}?api_key=${this.apiKey}&language=${config.tmdb.language}&page=${page}`;
                try {
                    console.log(`[HOT-LOOP] Scanning page ${page} of ${task.path}...`);
                    await handleTmdbRequest(url, true);
                    this.saveHotLoopCheckpoint(ti, page);
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e: any) {
                    console.error(`[HOT-LOOP] Failed page ${page}: ${e.message}`);
                }
            }
        }
        // Clear hot loop checkpoint after full cycle
        this.clearHotLoopCheckpoint();
    }

    // --- CHECKPOINTING LOGIC ---

    private saveCheckpoint(year: number, page: number) {
        const existing = this.loadCheckpoint();
        const state: WarmerState = {
            currentYear: year,
            lastCompletedPage: page,
            ...(existing?.lastCompletedTvPage != null ? { lastCompletedTvPage: existing.lastCompletedTvPage } : {}),
            yearInProgress: true,
        };
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(state));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        } catch (e) {
            // ignore write error
        }
    }

    private saveTvCheckpoint(year: number, page: number) {
        const existing = this.loadCheckpoint();
        const state: WarmerState = {
            currentYear: year,
            lastCompletedPage: existing?.lastCompletedPage ?? 0,
            ...(page > 0 ? { lastCompletedTvPage: page } : {}),
            yearInProgress: true,
        } as WarmerState;
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(state));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        } catch (e) {
            // ignore write error
        }
    }

    private saveHotLoopCheckpoint(taskIndex: number, pageIndex: number) {
        const existing = this.loadCheckpoint();
        const state: WarmerState = {
            currentYear: existing?.currentYear ?? new Date().getFullYear() + 1,
            lastCompletedPage: existing?.lastCompletedPage ?? 0,
            yearInProgress: existing?.yearInProgress ?? false,
            hotLoopTaskIndex: taskIndex,
            hotLoopPageIndex: pageIndex,
        } as WarmerState;
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(state));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        } catch (e) {
            // ignore write error
        }
    }

    private clearHotLoopCheckpoint() {
        const existing = this.loadCheckpoint();
        if (!existing) return;
        delete existing.hotLoopTaskIndex;
        delete existing.hotLoopPageIndex;
        try {
            fs.writeFileSync(CHECKPOINT_FILE + '.tmp', JSON.stringify(existing));
            fs.renameSync(CHECKPOINT_FILE + '.tmp', CHECKPOINT_FILE);
        } catch (e) {}
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
        const currentYear = new Date().getFullYear() + 1; // +1 to cover upcoming
        const startYear = 1880;

        // LOAD CHECKPOINT
        const state = this.loadCheckpoint();

        // Always start from currentYear; only use checkpoint for the starting page within that year
        if (state && state.yearInProgress) {
            console.log(`[WARMER] ♻️ Resuming from checkpoint: Year ${state.currentYear}, Page ${state.lastCompletedPage}`);
        }

        for (let year = currentYear; year >= startYear; year--) {
            if (!this.isRunning) break;
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

    private async crawlDiscover(endpoint: string, params: Record<string, string>, startPage = 1, currentYearForCheckpoint: number, isTv = false) {
        const urlParams = new URLSearchParams(params);
        urlParams.set('api_key', this.apiKey);
        urlParams.set('language', config.tmdb.language);
        urlParams.set('sort_by', 'popularity.desc');

        const MAX_PAGES = 500;
        let consecutiveErrors = 0;

        for (let page = startPage; page <= MAX_PAGES; page++) {
            if (!this.isRunning) break;

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
                } else {
                    this.saveCheckpoint(currentYearForCheckpoint, page);
                }

                if (data && data.total_pages && page >= data.total_pages) {
                    console.log(`[WARMER] Reached last page (${data.total_pages}) for this year.`);
                    break;
                }

                await new Promise(r => setTimeout(r, 1000));
            } catch (e: any) {
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
