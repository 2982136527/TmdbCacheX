import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from './proxy.js';
import { config, updateConfig, getConfigPath } from './config.js';
import { testDnsConnectivity } from './dns-resolver.js';
import axios from 'axios';

const startTime = Date.now();

function imgUrl(size: string, imgPath: string | null, forceProxy = false): string | null {
    if (!imgPath) return null;
    if (forceProxy || config.tmdb.proxyImages) return `/img/${size}${imgPath}`;
    return `https://image.tmdb.org/t/p/${size}${imgPath}`;
}

export async function adminRoutes(fastify: FastifyInstance, opts: { getWarmer: () => any }) {
    // Stats cache (30s TTL)
    let statsCache: any = null;
    let statsCacheTime = 0;
    const STATS_TTL = 30_000;

    // Current version from package.json
    let currentVersion = '0.0.0';
    try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
        currentVersion = pkg.version || '0.0.0';
    } catch {}

    // GET /admin/api/version - Check for updates (via proxy if configured)
    fastify.get('/admin/api/version', async () => {
        try {
            const proxyUrl = config.tmdb.httpProxy;
            const axiosCfg: any = { timeout: 8000, headers: { 'User-Agent': 'TmdbCacheX' } };
            if (proxyUrl) {
                const url = new URL(proxyUrl);
                axiosCfg.proxy = { host: url.hostname, port: Number(url.port), protocol: url.protocol.replace(':', '') };
            }
            const { data } = await axios.get('https://api.github.com/repos/2982136527/TmdbCacheX/releases/latest', axiosCfg);
            const latest = (data.tag_name || '').replace(/^v/, '');
            const body = (data.body || '')
                .replace(/\*\*Full Changelog\*\*:.*$/ms, '')
                .replace(/```[\s\S]*?```/g, '')
                .replace(/docker pull.*$/gm, '')
                .replace(/^#+\s*(Docker|使用方法|支持平台).*$/gim, '')
                .replace(/\*\*(GitHub Container Registry|Docker Hub|支持平台)\*\*.*$/gm, '')
                .replace(/ghcr\.io\/.*$/gm, '')
                .replace(/qiuhusama\/.*$/gm, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
                .slice(0, 1000);
            return { current: currentVersion, latest, hasUpdate: latest !== currentVersion, body };
        } catch {
            return { current: currentVersion, latest: currentVersion, hasUpdate: false, body: '' };
        }
    });

    // GET /admin/api/stats - Cache statistics (with 30s in-memory cache)
    fastify.get('/admin/api/stats', async () => {
        if (statsCache && Date.now() - statsCacheTime < STATS_TTL) return statsCache;

        const rows = await prisma.$queryRawUnsafe<Array<{ metric: string; cnt: number }>>(`
            SELECT 'total' as metric, COUNT(*) as cnt FROM TmdbCache
            UNION ALL SELECT 'expired', COUNT(*) FROM TmdbCache WHERE expiresAt < ${Date.now()}
            UNION ALL
            SELECT
                CASE
                    WHEN url LIKE '%/movie/%' THEN 'movies'
                    WHEN url LIKE '%/tv/%' THEN 'tvShows'
                    WHEN url LIKE '%/person/%' THEN 'people'
                    WHEN url LIKE '%/popular%' OR url LIKE '%/top_rated%' OR url LIKE '%/now_playing%'
                        OR url LIKE '%/on_the_air%' OR url LIKE '%/airing_today%' OR url LIKE '%/trending%'
                        OR url LIKE '%/discover%' THEN 'lists'
                    ELSE 'other'
                END as metric,
                COUNT(*) as cnt
            FROM TmdbCache GROUP BY metric
        `);

        const stats: any = { movies: 0, tvShows: 0, people: 0, lists: 0, other: 0 };
        for (const row of rows) {
            const v = Number(row.cnt);
            if (row.metric === 'total') stats.total = v;
            else if (row.metric === 'expired') stats.expired = v;
            else stats[row.metric] = v;
        }
        const total = stats.total || 0;
        const expired = stats.expired || 0;
        const breakdown = { movies: stats.movies, tvShows: stats.tvShows, people: stats.people, lists: stats.lists, other: stats.other };

        const uptimeMs = Date.now() - startTime;
        const uptimeHours = Math.floor(uptimeMs / 3600000);
        const uptimeMinutes = Math.floor((uptimeMs % 3600000) / 60000);

        // Database file size
        let dbSize = 0;
        try {
            const dbPath = path.resolve(process.cwd(), 'prisma', 'prisma', 'dev.db');
            const stat = fs.statSync(dbPath);
            dbSize = stat.size;
        } catch {}

        const result = {
            total,
            expired,
            active: total - expired,
            breakdown,
            uptime: { hours: uptimeHours, minutes: uptimeMinutes, ms: uptimeMs },
            dbSize,
        };
        statsCache = result;
        statsCacheTime = Date.now();
        return result;
    });

    // GET /admin/api/cache - List cache entries with pagination and search
    fastify.get('/admin/api/cache', async (request) => {
        const query = request.query as { page?: string; limit?: string; search?: string; type?: string };
        const page = Math.max(1, parseInt(query.page || '1'));
        const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20')));
        const search = query.search || '';
        const typeFilter = query.type || '';
        const skip = (page - 1) * limit;

        const where: any = {};
        if (search) {
            where.url = { contains: search };
        }
        if (typeFilter) {
            if (typeFilter === 'movie') where.url = { contains: '/movie/' };
            else if (typeFilter === 'tv') where.url = { contains: '/tv/' };
            else if (typeFilter === 'person') where.url = { contains: '/person/' };
        }

        const [items, total] = await Promise.all([
            prisma.tmdbCache.findMany({
                where,
                select: { id: true, url: true, createdAt: true, updatedAt: true, expiresAt: true },
                orderBy: { id: 'desc' },
                skip,
                take: limit,
            }),
            prisma.tmdbCache.count({ where }),
        ]);

        return {
            items,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    });

    // GET /admin/api/posters - Poster wall data for cached movies/TV
    fastify.get('/admin/api/posters', async (request) => {
        const query = request.query as { page?: string; limit?: string; type?: string; search?: string; proxy?: string };
        const page = Math.max(1, parseInt(query.page || '1'));
        const limit = Math.min(100, Math.max(1, parseInt(query.limit || '24')));
        const typeFilter = query.type || 'all';
        const searchQuery = (query.search || '').toLowerCase();
        const forceProxy = query.proxy === '1';
        const img = (size: string, p: string | null) => imgUrl(size, p, forceProxy);

        const movieWhere = "url LIKE '3/movie/%' AND url NOT LIKE '3/movie/%/%/%'";
        const tvWhere = "url LIKE '3/tv/%' AND url NOT LIKE '3/tv/%/%/%'";
        const where = typeFilter === 'movie' ? movieWhere
            : typeFilter === 'tv' ? tvWhere
            : `(${movieWhere} OR ${tvWhere})`;

        const seen = new Set<number>();
        const allMatched: any[] = [];

        if (searchQuery) {
            // Search mode: scan entries in batches, filter by title
            const BATCH = 500;
            let offset = 0;
            const maxScan = 10000; // safety limit
            while (allMatched.length < page * limit && offset < maxScan) {
                const entries = await prisma.$queryRawUnsafe<Array<{ url: string; response: string }>>(
                    `SELECT url, response FROM TmdbCache WHERE ${where} ORDER BY id DESC LIMIT ${BATCH} OFFSET ${offset}`
                );
                if (entries.length === 0) break;
                for (const entry of entries) {
                    try {
                        const data = JSON.parse(entry.response);
                        if (!data.poster_path || seen.has(data.id)) continue;
                        const isMovie = entry.url.startsWith('3/movie/');
                        const title = (isMovie ? data.title : data.name) || '';
                        if (!title.toLowerCase().includes(searchQuery)) continue;
                        seen.add(data.id);
                        allMatched.push({
                            tmdbId: data.id, type: isMovie ? 'movie' : 'tv',
                            title, posterPath: img('w500', data.poster_path),
                            voteAverage: data.vote_average ?? 0,
                            releaseDate: (isMovie ? data.release_date : data.first_air_date) || '',
                        });
                    } catch { /* skip */ }
                }
                offset += BATCH;
            }
            const total = allMatched.length;
            const totalPages = Math.ceil(total / limit);
            const items = allMatched.slice((page - 1) * limit, page * limit);
            return { items, total, page, totalPages };
        }

        // No search: direct SQL pagination
        const fetchLimit = limit * 3;
        const dbOffset = (page - 1) * fetchLimit;
        const entries = await prisma.$queryRawUnsafe<Array<{ url: string; response: string }>>(
            `SELECT url, response FROM TmdbCache WHERE ${where} ORDER BY id DESC LIMIT ${fetchLimit} OFFSET ${dbOffset}`
        );
        const items: any[] = [];
        for (const entry of entries) {
            if (items.length >= limit) break;
            try {
                const data = JSON.parse(entry.response);
                if (!data.poster_path || seen.has(data.id)) continue;
                seen.add(data.id);
                const isMovie = entry.url.startsWith('3/movie/');
                items.push({
                    tmdbId: data.id, type: isMovie ? 'movie' : 'tv',
                    title: (isMovie ? data.title : data.name) || 'Unknown',
                    posterPath: img('w500', data.poster_path),
                    voteAverage: data.vote_average ?? 0,
                    releaseDate: (isMovie ? data.release_date : data.first_air_date) || '',
                });
            } catch { /* skip */ }
        }
        const totalRow = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
            `SELECT COUNT(*) as cnt FROM TmdbCache WHERE ${where}`
        );
        const total = Number(totalRow[0]?.cnt || 0);
        const totalPages = Math.ceil(total / limit);
        return { items, total, page, totalPages };
    });

    // GET /admin/api/posters/detail/:tmdbId - Full detail for a cached movie/TV
    fastify.get('/admin/api/posters/detail/:tmdbId', async (request, reply) => {
        const { tmdbId } = request.params as { tmdbId: string };
        const query = request.query as { proxy?: string };
        const forceProxy = query.proxy === '1';
        const img = (size: string, p: string | null) => imgUrl(size, p, forceProxy);
        const id = parseInt(tmdbId);

        // Helper to build detail response from cache entry
        function buildDetail(entry: { url: string; response: string }) {
            const data = JSON.parse(entry.response);
            if (!((data.id === id) && (data.title || data.name) && data.poster_path && data.credits)) return null;
            const isMovie = /\/movie\//.test(entry.url);
            return {
                type: isMovie ? 'movie' : 'tv',
                tmdbId: data.id,
                title: isMovie ? data.title : data.name,
                originalTitle: isMovie ? data.original_title : data.original_name,
                overview: data.overview || '',
                posterPath: img('w500', data.poster_path),
                backdropPath: img('w780', data.backdrop_path),
                voteAverage: data.vote_average ?? 0,
                voteCount: data.vote_count ?? 0,
                releaseDate: isMovie ? data.release_date : data.first_air_date,
                runtime: data.runtime || data.episode_run_time?.[0] || null,
                genres: data.genres || [],
                tagline: data.tagline || '',
                status: data.status || '',
                budget: data.budget || 0,
                revenue: data.revenue || 0,
                homepage: data.homepage || '',
                imdbId: data.imdb_id || '',
                originalLanguage: data.original_language || '',
                productionCompanies: (data.production_companies || []).slice(0, 5),
                numberOfSeasons: data.number_of_seasons || null,
                numberOfEpisodes: data.number_of_episodes || null,
                seasons: (data.seasons || []).map((s: any) => ({ ...s, posterPath: img('w154', s.poster_path) })),
                networks: data.networks || null,
                createdBy: data.created_by || null,
                cast: (data.credits?.cast || []).slice(0, 12).map((c: any) => ({
                    id: c.id, name: c.name, character: c.character,
                    profilePath: img('w185', c.profile_path),
                })),
                backdrops: (data.images?.backdrops || []).slice(0, 6).map((b: any) => img('w780', b.file_path)),
                logoPath: (() => {
                    const logos = data.images?.logos || [];
                    const zh = logos.find((l: any) => l.iso_639_1 === 'zh');
                    if (zh) return img('w500', zh.file_path);
                    const en = logos.find((l: any) => l.iso_639_1 === 'en');
                    if (en) return img('w500', en.file_path);
                    return logos[0] ? img('w500', logos[0].file_path) : null;
                })(),
                videos: (data.videos?.results || []).filter((v: any) => v.site === 'YouTube').slice(0, 3).map((v: any) => ({ key: v.key, name: v.name, type: v.type })),
                recommendations: (data.recommendations?.results || []).slice(0, 8).map((r: any) => ({
                    tmdbId: r.id, title: r.title || r.name,
                    posterPath: img('w300', r.poster_path),
                })),
                watchProviders: data['watch/providers']?.results || null,
            };
        }

        // 1. Try exact URL match first (movie then TV)
        for (const type of ['movie', 'tv']) {
            const entry = await prisma.tmdbCache.findFirst({
                where: { OR: [
                    { url: `3/${type}/${id}` },
                    { url: { startsWith: `3/${type}/${id}?` } },
                ]},
                select: { url: true, response: true },
                orderBy: { updatedAt: 'desc' },
            });
            if (entry) {
                try {
                    const result = buildDetail(entry);
                    if (result) return result;
                } catch { /* skip */ }
            }
        }

        // 2. TMDB fallback — fetch from TMDB (auto-caches), then retry
        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const apiKey = config.tmdb.apiKey;
            const lang = config.tmdb.language;
            let fetched = false;
            try {
                await handleTmdbRequest(`3/movie/${id}?api_key=${apiKey}&language=${lang}`, true);
                fetched = true;
            } catch {}
            if (!fetched) {
                try {
                    await handleTmdbRequest(`3/tv/${id}?api_key=${apiKey}&language=${lang}`, true);
                    fetched = true;
                } catch {}
            }

            if (fetched) {
                for (const type of ['movie', 'tv']) {
                    const entry = await prisma.tmdbCache.findFirst({
                        where: { OR: [
                            { url: `3/${type}/${id}` },
                            { url: { startsWith: `3/${type}/${id}?` } },
                        ]},
                        select: { url: true, response: true },
                        orderBy: { updatedAt: 'desc' },
                    });
                    if (entry) {
                        try {
                            const result = buildDetail(entry);
                            if (result) return result;
                        } catch { /* skip */ }
                    }
                }
            }
        } catch {}

        reply.code(404).send({ error: 'Not found in cache' });
    });

    // GET /admin/api/tmdb/search - Search TMDB directly
    fastify.get('/admin/api/tmdb/search', async (request, reply) => {
        const query = request.query as { q?: string; type?: string };
        const q = query.q?.trim();
        if (!q) return { results: [] };

        const searchType = query.type || 'multi';
        const apiKey = config.tmdb.apiKey;
        const lang = config.tmdb.language;

        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const urlPath = `3/search/${searchType}?api_key=${apiKey}&language=${lang}&query=${encodeURIComponent(q)}&page=1`;
            const data = await handleTmdbRequest(urlPath, true);

            const results = (data.results || []).map((item: any) => {
                const isMovie = !!(item.title || item.release_date);
                const isTv = !!(item.name || item.first_air_date);
                const isPerson = item.media_type === 'person';

                if (isPerson) {
                    return {
                        type: 'person',
                        tmdbId: item.id,
                        title: item.name,
                        posterPath: imgUrl('w500', item.profile_path),
                    };
                }
                return {
                    type: isMovie ? 'movie' : 'tv',
                    tmdbId: item.id,
                    title: isMovie ? item.title : item.name,
                    posterPath: imgUrl('w500', item.poster_path),
                    voteAverage: item.vote_average ?? 0,
                    releaseDate: (isMovie ? item.release_date : item.first_air_date) || '',
                };
            }).filter((r: any) => r.posterPath);

            return { results, total: data.total_results || 0 };
        } catch (e: any) {
            reply.code(500).send({ error: e.message || 'TMDB search failed' });
        }
    });

    // GET /admin/api/tmdb/discover - Discover by genre
    fastify.get('/admin/api/tmdb/discover', async (request, reply) => {
        const query = request.query as { type?: string; genre?: string; page?: string };
        const type = query.type === 'tv' ? 'tv' : 'movie';
        const genre = query.genre;
        const page = Math.max(1, parseInt(query.page || '1'));
        if (!genre) return { results: [] };

        const apiKey = config.tmdb.apiKey;
        const lang = config.tmdb.language;
        const forceProxy = true;

        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const urlPath = `3/discover/${type}?api_key=${apiKey}&language=${lang}&with_genres=${genre}&sort_by=popularity.desc&page=${page}`;
            const data = await handleTmdbRequest(urlPath, true);

            const results = (data.results || []).filter((item: any) => item.poster_path).map((item: any) => ({
                tmdbId: item.id,
                title: type === 'movie' ? item.title : item.name,
                posterPath: imgUrl('w300', item.poster_path, forceProxy),
                voteAverage: item.vote_average ?? 0,
                releaseDate: (type === 'movie' ? item.release_date : item.first_air_date) || '',
            }));

            return { results, page, totalPages: data.total_pages || 1 };
        } catch (e: any) {
            reply.code(500).send({ error: e.message || 'Discover failed' });
        }
    });

    // GET /admin/api/tmdb/person/:id - Person detail with credits
    fastify.get('/admin/api/tmdb/person/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const query = request.query as { proxy?: string };
        const forceProxy = query.proxy === '1';
        const img = (size: string, p: string | null) => imgUrl(size, p, forceProxy);

        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const apiKey = config.tmdb.apiKey;
            const lang = config.tmdb.language;
            const urlPath = `3/person/${id}?api_key=${apiKey}&language=${lang}&append_to_response=combined_credits,images,external_ids`;
            const data = await handleTmdbRequest(urlPath, true);

            return {
                id: data.id,
                name: data.name,
                biography: data.biography || '',
                birthday: data.birthday || null,
                place_of_birth: data.place_of_birth || null,
                known_for_department: data.known_for_department || '',
                profile_path: img('w185', data.profile_path),
                combined_credits: data.combined_credits || { cast: [] },
            };
        } catch (e: any) {
            reply.code(500).send({ error: e.message || 'Failed to fetch person' });
        }
    });

    // GET /admin/api/posters/season/:tvId/:seasonNumber - Season detail
    fastify.get('/admin/api/posters/season/:tvId/:seasonNumber', async (request, reply) => {
        const { tvId, seasonNumber } = request.params as { tvId: string; seasonNumber: string };
        const query = request.query as { proxy?: string };
        const forceProxy = query.proxy === '1';
        const img = (size: string, p: string | null) => imgUrl(size, p, forceProxy);
        const apiKey = config.tmdb.apiKey;
        const lang = config.tmdb.language;

        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const urlPath = `3/tv/${tvId}/season/${seasonNumber}?api_key=${apiKey}&language=${lang}`;
            const data = await handleTmdbRequest(urlPath, true);

            return {
                name: data.name || `第 ${seasonNumber} 季`,
                overview: data.overview || '',
                airDate: data.air_date || '',
                posterPath: img('w300', data.poster_path),
                episodes: (data.episodes || []).map((ep: any) => ({
                    episodeNumber: ep.episode_number,
                    name: ep.name || '',
                    overview: ep.overview || '',
                    airDate: ep.air_date || '',
                    runtime: ep.runtime || null,
                    stillPath: img('w300', ep.still_path),
                    voteAverage: ep.vote_average ?? 0,
                })),
            };
        } catch (e: any) {
            reply.code(500).send({ error: e.message || 'Failed to fetch season' });
        }
    });

    // GET /admin/api/cache/:id - Get single cache entry detail
    fastify.get('/admin/api/cache/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const entry = await prisma.tmdbCache.findUnique({
            where: { id: parseInt(id) },
        });

        if (!entry) {
            reply.code(404).send({ error: 'Not found' });
            return;
        }

        let parsedResponse: any;
        try {
            parsedResponse = JSON.parse(entry.response);
        } catch {
            parsedResponse = null;
        }

        return {
            id: entry.id,
            url: entry.url,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            expiresAt: entry.expiresAt,
            responseSize: entry.response.length,
            title: parsedResponse?.title || parsedResponse?.name || null,
            tmdbId: parsedResponse?.id || null,
        };
    });

    // DELETE /admin/api/cache/:id - Delete single cache entry
    fastify.delete('/admin/api/cache/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        try {
            await prisma.tmdbCache.delete({ where: { id: parseInt(id) } });
            return { success: true };
        } catch {
            reply.code(404).send({ error: 'Not found' });
        }
    });

    // DELETE /admin/api/cache - Clear all cache
    fastify.delete('/admin/api/cache', async () => {
        const result = await prisma.tmdbCache.deleteMany();
        return { success: true, deleted: result.count };
    });

    // GET /admin/api/warmer/status - Warmer status
    fastify.get('/admin/api/warmer/status', async () => {
        const warmer = opts.getWarmer();
        return {
            running: warmer?.isRunning ?? false,
        };
    });

    // POST /admin/api/warmer/stop - Stop warmer
    fastify.post('/admin/api/warmer/stop', async () => {
        const warmer = opts.getWarmer();
        if (warmer) warmer.stop();
        return { success: true, running: false };
    });

    // POST /admin/api/warmer/start - Start warmer
    fastify.post('/admin/api/warmer/start', async () => {
        const warmer = opts.getWarmer();
        if (warmer) warmer.start();
        return { success: true, running: true };
    });

    // GET /admin/api/dns/test - Test DNS connectivity
    fastify.get('/admin/api/dns/test', async () => {
        return await testDnsConnectivity();
    });

    // GET /admin/api/config - Current config (masked)
    fastify.get('/admin/api/config', async () => {
        return {
            tmdb: {
                apiKey: config.tmdb.apiKey.substring(0, 6) + '***' + config.tmdb.apiKey.slice(-4),
                language: config.tmdb.language,
                httpProxy: config.tmdb.httpProxy || '',
                authKey: config.tmdb.authKey ? '***' : '',
                proxyImages: config.tmdb.proxyImages,
                resolveTmdbDns: config.tmdb.resolveTmdbDns,
            },
            server: {
                port: config.server.port,
            },
            adminProxyImages: config.adminProxyImages,
            enableCacheTtl: config.enableCacheTtl,
        };
    });

    // GET /admin/api/config/raw - Current config (unmasked, for editing)
    fastify.get('/admin/api/config/raw', async () => {
        return {
            tmdb: {
                apiKey: config.tmdb.apiKey,
                language: config.tmdb.language,
                httpProxy: config.tmdb.httpProxy || '',
                authKey: config.tmdb.authKey || '',
                proxyImages: config.tmdb.proxyImages,
                resolveTmdbDns: config.tmdb.resolveTmdbDns,
            },
            server: {
                port: config.server.port,
            },
            adminProxyImages: config.adminProxyImages,
            enableCacheTtl: config.enableCacheTtl,
        };
    });

    // PUT /admin/api/config - Update config
    fastify.put('/admin/api/config', async (request, reply) => {
        const body = request.body as {
            tmdb?: { apiKey?: string; language?: string; httpProxy?: string; authKey?: string; proxyImages?: boolean; resolveTmdbDns?: boolean };
            server?: { port?: number };
            adminProxyImages?: boolean;
            enableCacheTtl?: boolean;
        };

        // Build new config
        const newConfig: any = {
            tmdb: {
                apiKey: body?.tmdb?.apiKey || config.tmdb.apiKey,
                language: body?.tmdb?.language || config.tmdb.language,
                httpProxy: body?.tmdb?.httpProxy !== undefined ? body.tmdb.httpProxy : config.tmdb.httpProxy,
                authKey: body?.tmdb?.authKey !== undefined ? body.tmdb.authKey : config.tmdb.authKey,
                proxyImages: body?.tmdb?.proxyImages !== undefined ? body.tmdb.proxyImages : config.tmdb.proxyImages,
                resolveTmdbDns: body?.tmdb?.resolveTmdbDns !== undefined ? body.tmdb.resolveTmdbDns : config.tmdb.resolveTmdbDns,
            },
            server: {
                port: body?.server?.port || config.server.port,
            },
            adminProxyImages: body?.adminProxyImages !== undefined ? body.adminProxyImages : config.adminProxyImages,
            enableCacheTtl: body?.enableCacheTtl !== undefined ? body.enableCacheTtl : config.enableCacheTtl,
        };

        // Validate
        if (!newConfig.tmdb.apiKey || newConfig.tmdb.apiKey.length < 5) {
            reply.code(400).send({ error: 'API Key 无效' });
            return;
        }

        if (!['zh-CN', 'en-US', 'ja-JP', 'ko-KR', 'zh-TW'].includes(newConfig.tmdb.language)) {
            reply.code(400).send({ error: '不支持的语言' });
            return;
        }

        if (newConfig.server.port < 1 || newConfig.server.port > 65535) {
            reply.code(400).send({ error: '端口无效' });
            return;
        }

        // Write to config.json (atomic: write to temp file then rename)
        const configPath = getConfigPath();
        const tmpPath = configPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2) + '\n');
            fs.renameSync(tmpPath, configPath);
            // Apply API key and language changes in-memory (port requires restart)
            const portChanged = newConfig.server.port !== config.server.port;
            updateConfig({ tmdb: { apiKey: newConfig.tmdb.apiKey, language: newConfig.tmdb.language, httpProxy: newConfig.tmdb.httpProxy, authKey: newConfig.tmdb.authKey, proxyImages: newConfig.tmdb.proxyImages, resolveTmdbDns: newConfig.tmdb.resolveTmdbDns }, adminProxyImages: newConfig.adminProxyImages, enableCacheTtl: newConfig.enableCacheTtl });
            return { success: true, message: portChanged ? '已保存，端口变更需重启服务生效' : '配置已即时生效' };
        } catch (e: any) {
            try { fs.unlinkSync(tmpPath); } catch {}
            reply.code(500).send({ error: `写入配置文件失败: ${e.message}` });
        }
    });

    // --- API Log Endpoints ---

    // GET /admin/api/logs/stats - Log statistics
    fastify.get('/admin/api/logs/stats', async () => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [total, todayCount, hitCount, externalCount, topItems] = await Promise.all([
            prisma.apiLog.count(),
            prisma.apiLog.count({ where: { createdAt: { gte: today } } }),
            prisma.apiLog.count({ where: { hit: true } }),
            prisma.apiLog.count({ where: { source: 'external' } }),
            prisma.apiLog.groupBy({
                by: ['title', 'url'],
                where: { title: { not: null }, type: { in: ['movie', 'tv', 'person'] } },
                _count: { title: true },
                orderBy: { _count: { title: 'desc' } },
                take: 10,
            }),
        ]);

        return {
            total,
            today: todayCount,
            hitRate: total > 0 ? Math.round((hitCount / total) * 100) : 0,
            external: externalCount,
            topItems: topItems.map(item => {
                const match = item.url.match(/\/(movie|tv|person)\/(\d+)/);
                return {
                    title: item.title,
                    count: item._count.title,
                    type: match ? match[1] : null,
                    tmdbId: match && match[2] ? parseInt(match[2]) : null,
                };
            }),
        };
    });

    // GET /admin/api/logs - List logs with pagination
    fastify.get('/admin/api/logs', async (request) => {
        const query = request.query as { page?: string; limit?: string; type?: string; source?: string };
        const page = Math.max(1, parseInt(query.page || '1'));
        const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20')));
        const skip = (page - 1) * limit;

        const where: any = {};
        if (query.type) where.type = query.type;
        if (query.source) where.source = query.source;

        const [items, total] = await Promise.all([
            prisma.apiLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            prisma.apiLog.count({ where }),
        ]);

        return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
    });

    // DELETE /admin/api/logs - Clear all logs
    fastify.delete('/admin/api/logs', async () => {
        const result = await prisma.apiLog.deleteMany();
        return { success: true, deleted: result.count };
    });

    // PUT /admin/api/logs/config - Update log retention days
    fastify.put('/admin/api/logs/config', async (request, reply) => {
        const body = request.body as { logRetentionDays?: number };
        const days = body?.logRetentionDays;
        if (days === undefined || days < 0) {
            reply.code(400).send({ error: '无效的保留天数' });
            return;
        }

        const configPath = path.resolve(process.cwd(), 'config.json');
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        raw.logRetentionDays = days;
        const tmpPath = configPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(raw, null, 2) + '\n');
            fs.renameSync(tmpPath, configPath);
            updateConfig({ logRetentionDays: days });
            return { success: true, message: days === 0 ? '日志将永久保存' : `日志保留 ${days} 天` };
        } catch (e: any) {
            try { fs.unlinkSync(tmpPath); } catch {}
            reply.code(500).send({ error: e.message });
        }
    });

    // --- Log Cleanup Timer ---
    setInterval(async () => {
        const days = config.logRetentionDays;
        if (days <= 0) return; // 0 = permanent
        const cutoff = new Date(Date.now() - days * 86400000);
        try {
            const result = await prisma.apiLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
            if (result.count > 0) console.log(`[LOG-CLEANUP] Cleaned ${result.count} logs older than ${days} days`);
        } catch (e) {}
    }, 3600000); // Every hour
}