
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { config } from './config.js';
import { getDnsAgent } from './dns-resolver.js';

export const prisma = new PrismaClient();
const TMDB_BASE_URL = 'https://api.themoviedb.org';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

export function getProxyConfig(): { proxy?: { host: string; port: number; protocol: string } } {
    const p = config.tmdb.httpProxy;
    if (!p) return {};
    try {
        const url = new URL(p);
        return {
            proxy: {
                host: url.hostname,
                port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
                protocol: url.protocol.replace(':', ''),
            }
        };
    } catch { return {}; }
}

// Prefetch queue with bounds and dedup
const prefetchQueue: string[] = [];
const enqueuedUrls = new Set<string>();
let isProcessingQueue = false;
const MAX_QUEUE_SIZE = 500;

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (prefetchQueue.length > 0) {
        const url = prefetchQueue.shift();
        if (url) {
            enqueuedUrls.delete(url);
            try {
                await handleTmdbRequest(url, true);
                await new Promise(r => setTimeout(r, 250));
            } catch (e) {
                console.error(`[PREFETCH] Failed: ${getCacheKey(url)}`);
            }
        }
    }
    enqueuedUrls.clear();
    isProcessingQueue = false;
}

export async function handleTmdbRequest(urlPath: string, isBackground = false): Promise<any> {
    // 1. Auth key validation & replacement (before cache check)
    const urlObj = new URL(urlPath, TMDB_BASE_URL);
    const incomingKey = urlObj.searchParams.get('api_key');
    if (incomingKey) {
        // Only validate auth for external requests (not cache warmer/prefetch)
        if (!isBackground && config.tmdb.authKey) {
            if (incomingKey !== config.tmdb.authKey) {
                const err: any = new Error('Invalid API key');
                err.response = { status: 401, data: { status_message: 'Invalid API key' } };
                throw err;
            }
        }
        // Always replace with real TMDB key (handles custom keys from Emby plugins)
        if (incomingKey !== config.tmdb.apiKey) {
            urlObj.searchParams.set('api_key', config.tmdb.apiKey);
            urlPath = (urlObj.pathname + urlObj.search).replace(/^\//, '');
        }
    }

    // 2. Compute cache key (normalize: strip api_key, sort params, strip append_to_response for detail endpoints)
    const cacheKey = getCacheKey(urlPath);

    const cached = await prisma.tmdbCache.findUnique({
        where: { url: cacheKey }
    });

    if (cached) {
        // Check TTL
        const age = Date.now() - new Date(cached.updatedAt).getTime();
        if (age < CACHE_TTL_MS) {
            const data = JSON.parse(cached.response);
            if (isBackground) {
                // Still trigger prefetch for list pages even on cache hit
                if (data.results && Array.isArray(data.results)) {
                    triggerBackgroundPrefetch(data, urlPath);
                }
                return data;
            }

            console.log(`[CACHE HIT] ${cacheKey}`);
            triggerBackgroundPrefetch(data, urlPath);
            return data;
        }
        console.log(`[CACHE EXPIRED] ${cacheKey}`);
    }

    // 2. Construct upstream URL
    let upstreamUrl = `${TMDB_BASE_URL}/${urlPath}`;

    // Auto-Enrichment for detail endpoints
    const movieTvMatch = urlPath.match(/(^|\/)3\/(movie|tv)\/(\d+)(\?|$)/);
    const personMatch = urlPath.match(/(^|\/)3\/person\/(\d+)(\?|$)/);

    if (movieTvMatch) {
        const contentType = movieTvMatch[2]; // 'movie' or 'tv'
        const urlObj = new URL(upstreamUrl);

        // Common fields for both movie and TV
        const commonFields = 'credits,images,videos,external_ids,recommendations,similar,keywords,watch/providers';

        // Content-type specific fields
        const typeSpecificFields = contentType === 'movie'
            ? 'release_dates'       // movie: release_dates (certifications)
            : 'content_ratings,aggregate_credits'; // TV: content_ratings + aggregate_credits

        const extraFields = `${commonFields},${typeSpecificFields}`;
        const existingAppend = urlObj.searchParams.get('append_to_response');

        if (!existingAppend || !existingAppend.includes('credits')) {
            const newAppend = existingAppend ? `${existingAppend},${extraFields}` : extraFields;
            urlObj.searchParams.set('append_to_response', newAppend);
            urlObj.searchParams.set('include_image_language', 'zh,null');
            upstreamUrl = urlObj.toString();
        }
    } else if (personMatch) {
        // Enrich person endpoints with credits and images
        const urlObj = new URL(upstreamUrl);
        const extraFields = 'combined_credits,images,external_ids,movie_credits,tv_credits';
        const existingAppend = urlObj.searchParams.get('append_to_response');

        if (!existingAppend || !existingAppend.includes('combined_credits')) {
            const newAppend = existingAppend ? `${existingAppend},${extraFields}` : extraFields;
            urlObj.searchParams.set('append_to_response', newAppend);
            upstreamUrl = urlObj.toString();
        }
    }

    try {
        const dnsConfig = config.tmdb.resolveTmdbDns ? { httpsAgent: getDnsAgent() } : {};
        const maxRetries = 9;
        let lastError: any;
        let response: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                response = await axios.get(upstreamUrl, {
                    headers: {
                        'User-Agent': 'TmdbCacheX/1.0'
                    },
                    timeout: 15000,
                    ...getProxyConfig(),
                    ...dnsConfig,
                });
                break;
            } catch (err: any) {
                lastError = err;
                const status = err.response?.status;
                const code = err.code || '';
                const isRetryable = !status || status === 429 || status >= 500
                    || code === 'ECONNRESET' || code === 'ECONNABORTED'
                    || err.message?.includes('TLS') || err.message?.includes('socket');

                if (attempt < maxRetries && isRetryable) {
                    const delay = (attempt + 1) * 2000;
                    console.warn(`[PROXY] Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err.message}`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    throw lastError;
                }
            }
        }
        const data = response.data;

        // 3. Save to Cache (cache stringify result to avoid double work)
        const responseStr = JSON.stringify(data);
        const now = new Date();
        await prisma.tmdbCache.upsert({
            where: { url: cacheKey },
            update: { response: responseStr, expiresAt: new Date(now.getTime() + CACHE_TTL_MS) },
            create: {
                url: cacheKey,
                response: responseStr,
                expiresAt: new Date(now.getTime() + CACHE_TTL_MS)
            }
        });

        const title = data.title || data.name;
        if (title) {
            console.log(`✅ [${isBackground ? 'Auto-Crawl' : 'Fetch'}] ${title} (ID:${data.id})`);
        } else if (isBackground) {
            console.log(`✅ [Auto-Crawl] Fetched ${cacheKey}`);
        }

        // 4. Trigger Background Prefetch
        // Always trigger for list pages (including Warmer); skip for prefetched detail pages to avoid cascading
        const isListPage = data.results && Array.isArray(data.results);
        if (isListPage || !isBackground) {
            triggerBackgroundPrefetch(data, urlPath);
        }

        return data;
    } catch (error) {
        throw error;
    }
}

function enqueueUrl(url: string) {
    if (enqueuedUrls.has(url)) return false;
    if (prefetchQueue.length >= MAX_QUEUE_SIZE) return false;
    prefetchQueue.push(url);
    enqueuedUrls.add(url);
    return true;
}

function triggerBackgroundPrefetch(data: any, originalUrl: string) {
    try {
        const urlObj = new URL(originalUrl, TMDB_BASE_URL);
        const extractedApiKey = urlObj.searchParams.get('api_key');
        if (!extractedApiKey) return;

        const lang = urlObj.searchParams.get('language') || 'zh-CN';
        let addedCount = 0;

        // 1. Prefetch from list/search results
        if (data.results && Array.isArray(data.results)) {
            let type = 'movie';
            if (originalUrl.includes('/tv')) type = 'tv';

            for (const item of data.results) {
                const itemType = item.media_type || type;
                if (itemType === 'person') {
                    // Prefetch person details too
                    const personUrl = `3/person/${item.id}?api_key=${extractedApiKey}&language=${lang}`;
                    if (enqueueUrl(personUrl)) addedCount++;
                } else if (itemType === 'movie' || itemType === 'tv') {
                    const detailUrl = `3/${itemType}/${item.id}?api_key=${extractedApiKey}&language=${lang}`;
                    if (enqueueUrl(detailUrl)) addedCount++;
                }
            }
        }

        // 2. Prefetch from detail page: recommendations and similar
        if (data.recommendations?.results?.length) {
            for (const item of data.recommendations.results) {
                if (prefetchQueue.length >= MAX_QUEUE_SIZE) break;
                const itemType = item.media_type || 'movie';
                if (itemType !== 'movie' && itemType !== 'tv') continue;
                const recUrl = `3/${itemType}/${item.id}?api_key=${extractedApiKey}&language=${lang}`;
                if (enqueueUrl(recUrl)) addedCount++;
            }
        }

        if (data.similar?.results?.length) {
            for (const item of data.similar.results) {
                if (prefetchQueue.length >= MAX_QUEUE_SIZE) break;
                // Detect type from original URL
                const itemType = originalUrl.includes('/tv') ? 'tv' : 'movie';
                const simUrl = `3/${itemType}/${item.id}?api_key=${extractedApiKey}&language=${lang}`;
                if (enqueueUrl(simUrl)) addedCount++;
            }
        }

        // 3. Prefetch collection if movie belongs to one
        if (data.belongs_to_collection?.id) {
            const colUrl = `3/collection/${data.belongs_to_collection.id}?api_key=${extractedApiKey}&language=${lang}`;
            if (enqueueUrl(colUrl)) addedCount++;
        }

        if (addedCount > 0) {
            console.log(`[PREFETCH] Scheduled ${addedCount} items.`);
            processQueue();
        }
    } catch (e: any) {
        console.error(`[PREFETCH ERROR] Error triggering background fetch: ${e.message}`);
    }
}

function getCacheKey(fullUrl: string): string {
    try {
        const parts = fullUrl.split('?');
        const urlPath = parts[0];
        if (!urlPath) return fullUrl;
        const search = parts[1];
        if (!search) return urlPath;
        const params = new URLSearchParams(search);
        params.delete('api_key');
        // Strip append_to_response from key since enrichment handles it uniformly
        params.delete('append_to_response');
        params.delete('include_image_language');
        params.sort();
        const queryString = params.toString();
        return queryString ? `${urlPath}?${queryString}` : urlPath;
    } catch (e) {
        return fullUrl;
    }
}
