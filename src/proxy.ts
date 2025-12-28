
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();
const TMDB_BASE_URL = 'https://api.themoviedb.org';

// You might want to get this from env or pass it in the request if you want to support different keys
// For now, we assume the user passes the api_key in the query string, so we just forward it.
// IF the user wants us to manage the key, we could inject it here.

// Simple in-memory queue for background prefetching
const prefetchQueue: string[] = [];
let isProcessingQueue = false;

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (prefetchQueue.length > 0) {
        const url = prefetchQueue.shift();
        if (url) {
            try {
                // Ensure we don't re-trigger prefetch for these background requests to avoid loops
                // (Though our logic only prefetches on 'results' lists, and details don't have results, safe enough)
                console.log(`[PREFETCH] Processing background job: ${url}`);
                await handleTmdbRequest(url, true); // true = isBackground
                await new Promise(r => setTimeout(r, 250)); // Rate limit protection
            } catch (e) {
                console.error(`[PREFETCH] Failed: ${url}`);
            }
        }
    }
    isProcessingQueue = false;
}

export async function handleTmdbRequest(urlPath: string, isBackground = false): Promise<any> {
    // 1. Check Cache
    // We cache by the exact URL path + query string.

    // Normalize logic for cache key (stripping API key is good practice but kept simple here as per previous code)
    const cacheKey = getCacheKey(urlPath);

    const cached = await prisma.tmdbCache.findUnique({
        where: { url: cacheKey }
    });

    if (cached) {
        // If it's a background request and we have it, just return (job done)
        if (isBackground) return JSON.parse(cached.response);

        console.log(`[CACHE HIT] ${cacheKey}`);
        const data = JSON.parse(cached.response);

        // Even on cache hit, if it looks like a list, we might want to ensure children are cached?
        // For now, let's only trigger on FRESH fetches or if user explicitly wants "active" caching constantly.
        // Let's safe trigger just in case the list is cached but children aren't.
        if (!isBackground) triggerBackgroundPrefetch(data, urlPath);

        return data;
    }

    // 2. Fetch from TMDB
    // console.log(`[CACHE MISS] ${cacheKey} -> Fetching from upstream${isBackground ? ' (Background)' : ''}`);

    // Construct upstream URL
    let upsreamUrl = `${TMDB_BASE_URL}/${urlPath}`;

    // Auto-Enrichment: If this is a details request
    const detailsMatch = urlPath.match(/(^|\/)3\/(movie|tv)\/(\d+)(\?|$)/);
    if (detailsMatch) {
        // console.log(`[ENRICH] Detected details request. Injecting full metadata...`);
        const urlObj = new URL(upsreamUrl);
        // Params we want to force
        const extraFields = 'credits,images,release_dates,videos,external_ids,content_ratings';
        // Merge with existing append_to_response if any
        const existingAppend = urlObj.searchParams.get('append_to_response');

        // Only add if not present to avoid duplication if re-processing
        if (!existingAppend || !existingAppend.includes('credits')) {
            const newAppend = existingAppend ? `${existingAppend},${extraFields}` : extraFields;
            urlObj.searchParams.set('append_to_response', newAppend);
            urlObj.searchParams.set('include_image_language', 'zh,null');
            upsreamUrl = urlObj.toString();
        }
    }

    try {
        const response = await axios.get(upsreamUrl, {
            headers: {
                'User-Agent': 'TmdbCacheX/1.0'
            }
        });
        const data = response.data;

        // 3. Save to Cache
        // Use upsert to handle race conditions where background prefetch might have inserted it already
        await prisma.tmdbCache.upsert({
            where: { url: cacheKey },
            update: { response: JSON.stringify(data) },
            create: {
                url: cacheKey,
                response: JSON.stringify(data)
            }
        });

        const title = data.title || data.name;
        if (title) {
            console.log(`✅ [${isBackground ? 'Auto-Crawl' : 'Fetch'}] ${title} (ID:${data.id})`);
        } else if (isBackground) {
            console.log(`✅ [Auto-Crawl] Fetched ${urlPath}`);
        }

        // 4. Trigger Background Prefetch if active request
        if (!isBackground) {
            triggerBackgroundPrefetch(data, urlPath);
        }

        return data;
    } catch (error) {
        throw error;
    }
}

function triggerBackgroundPrefetch(data: any, originalUrl: string) {
    try {
        if (!data.results || !Array.isArray(data.results)) return;

        // Extract API key from original request to reuse
        const urlObj = new URL(originalUrl, TMDB_BASE_URL);
        const apiKey = urlObj.searchParams.get('api_key');
        if (!apiKey) return;

        // Detect content type
        let type = 'movie';
        if (originalUrl.includes('/tv')) type = 'tv';
        // If mixed (multi-search), try to infer from item media_type

        let addedCount = 0;
        for (const item of data.results) {
            const itemType = item.media_type || type; // 'person', 'movie', 'tv'
            if (itemType !== 'movie' && itemType !== 'tv') continue;

            // Construct the details URL
            // We want the same language as the list usually
            const lang = urlObj.searchParams.get('language') || 'zh-CN';

            const prefetchUrl = `3/${itemType}/${item.id}?api_key=${apiKey}&language=${lang}`;

            // Check if already in queue or (ideally) if already cached? 
            // For simplicity, just push. The cache check in handleTmdbRequest handles existence.
            prefetchQueue.push(prefetchUrl);
            addedCount++;
        }

        if (addedCount > 0) {
            console.log(`[PREFETCH] Scheduled ${addedCount} items from list results.`);
            processQueue();
        }
    } catch (e: any) {
        console.error(`[PREFETCH ERROR] Error triggering background fetch: ${e.message}`);
    }
}

function getCacheKey(fullUrl: string): string {
    // Simplistic approach: use the full URL string as key.
    // If we want to ignore api_key for caching purposes:
    try {
        // fullUrl is likely "3/movie/550?api_key=xyz&language=en-US"
        const parts = fullUrl.split('?');
        const path = parts[0];
        if (!path) return fullUrl;
        const search = parts[1];
        if (!search) return path;
        const params = new URLSearchParams(search);
        params.delete('api_key');
        params.sort(); // normalize order
        const queryString = params.toString();
        return queryString ? `${path}?${queryString}` : path;
    } catch (e) {
        return fullUrl;
    }
}
