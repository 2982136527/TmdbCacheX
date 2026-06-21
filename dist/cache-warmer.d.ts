/**
 * CacheWarmer
 * Actively triggers requests for popular/top-rated content to "warm up" the cache.
 */
export declare class CacheWarmer {
    private isRunning;
    private apiKey;
    constructor();
    start(): void;
    stop(): void;
    private startHotLoop;
    private startColdLoop;
    private runHotCrawl;
    private saveCheckpoint;
    private saveTvCheckpoint;
    private saveHotLoopCheckpoint;
    private clearHotLoopCheckpoint;
    private loadCheckpoint;
    private runFullCrawl;
    private crawlDiscover;
}
//# sourceMappingURL=cache-warmer.d.ts.map