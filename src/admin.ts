import type { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { prisma } from './proxy.js';
import { config, updateConfig } from './config.js';
import { testDnsConnectivity } from './dns-resolver.js';

const startTime = Date.now();

function imgUrl(size: string, imgPath: string | null, forceProxy = false): string | null {
    if (!imgPath) return null;
    if (forceProxy || config.tmdb.proxyImages) return `/img/${size}${imgPath}`;
    return `https://image.tmdb.org/t/p/${size}${imgPath}`;
}

export async function adminRoutes(fastify: FastifyInstance, opts: { getWarmer: () => any }) {
    // GET /admin/api/stats - Cache statistics
    fastify.get('/admin/api/stats', async () => {
        const total = await prisma.tmdbCache.count();
        const now = new Date();
        const expired = await prisma.tmdbCache.count({
            where: { expiresAt: { lt: now } }
        });

        // Count by content type
        const allKeys = await prisma.tmdbCache.findMany({
            select: { url: true },
        });

        let movies = 0, tvShows = 0, people = 0, lists = 0, other = 0;
        for (const row of allKeys) {
            const url = row.url;
            if (/\/movie\/\d+/.test(url)) movies++;
            else if (/\/tv\/\d+/.test(url)) tvShows++;
            else if (/\/person\/\d+/.test(url)) people++;
            else if (/\/(popular|top_rated|now_playing|on_the_air|airing_today|trending|discover)/.test(url)) lists++;
            else other++;
        }

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

        return {
            total,
            expired,
            active: total - expired,
            breakdown: { movies, tvShows, people, lists, other },
            uptime: { hours: uptimeHours, minutes: uptimeMinutes, ms: uptimeMs },
            dbSize,
        };
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
                orderBy: { updatedAt: 'desc' },
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

        // Fetch all cache entries (we need to parse responses to extract posters)
        const entries = await prisma.tmdbCache.findMany({
            select: { id: true, url: true, response: true },
            orderBy: { updatedAt: 'desc' },
        });

        const seen = new Set<number>();
        const allItems: any[] = [];

        for (const entry of entries) {
            try {
                const data = JSON.parse(entry.response);

                // Detail page: /movie/123 or /tv/123
                if (/\/movie\/\d+/.test(entry.url) && (typeFilter === 'all' || typeFilter === 'movie')) {
                    if (data.poster_path && !seen.has(data.id)) {
                        seen.add(data.id);
                        allItems.push({
                            tmdbId: data.id, type: 'movie',
                            title: data.title || 'Unknown',
                            posterPath: img('w500', data.poster_path),
                            voteAverage: data.vote_average ?? 0,
                            releaseDate: data.release_date || '',
                        });
                    }
                } else if (/\/tv\/\d+/.test(entry.url) && (typeFilter === 'all' || typeFilter === 'tv')) {
                    if (data.poster_path && !seen.has(data.id)) {
                        seen.add(data.id);
                        allItems.push({
                            tmdbId: data.id, type: 'tv',
                            title: data.name || 'Unknown',
                            posterPath: img('w500', data.poster_path),
                            voteAverage: data.vote_average ?? 0,
                            releaseDate: data.first_air_date || '',
                        });
                    }
                }
                // List page: results[] array
                else if (Array.isArray(data.results)) {
                    const isMovieList = /\/movie\//.test(entry.url) || /\/trending\/movie\//.test(entry.url) || /\/discover\/movie/.test(entry.url);
                    const isTvList = /\/tv\//.test(entry.url) || /\/trending\/tv\//.test(entry.url) || /\/discover\/tv/.test(entry.url);
                    const wantType = isMovieList ? 'movie' : isTvList ? 'tv' : 'all';
                    if (typeFilter !== 'all' && wantType !== 'all' && wantType !== typeFilter) continue;

                    for (const item of data.results) {
                        if (!item.poster_path || seen.has(item.id)) continue;
                        seen.add(item.id);
                        const isMovie = wantType === 'movie' || (wantType === 'all' && (item.title || item.release_date));
                        allItems.push({
                            tmdbId: item.id, type: isMovie ? 'movie' : 'tv',
                            title: (isMovie ? item.title : item.name) || 'Unknown',
                            posterPath: img('w500', item.poster_path),
                            voteAverage: item.vote_average ?? 0,
                            releaseDate: (isMovie ? item.release_date : item.first_air_date) || '',
                        });
                    }
                }
            } catch { /* skip unparseable */ }
        }

        const filtered = searchQuery
            ? allItems.filter(item => item.title.toLowerCase().includes(searchQuery))
            : allItems;

        const total = filtered.length;
        const totalPages = Math.ceil(total / limit);
        const items = filtered.slice((page - 1) * limit, page * limit);

        return { items, total, page, totalPages };
    });

    // GET /admin/api/posters/detail/:tmdbId - Full detail for a cached movie/TV
    fastify.get('/admin/api/posters/detail/:tmdbId', async (request, reply) => {
        const { tmdbId } = request.params as { tmdbId: string };
        const query = request.query as { proxy?: string };
        const forceProxy = query.proxy === '1';
        const img = (size: string, p: string | null) => imgUrl(size, p, forceProxy);
        const id = parseInt(tmdbId);

        // Try detail page first (URL contains the id)
        const entries = await prisma.tmdbCache.findMany({
            select: { url: true, response: true },
            orderBy: { updatedAt: 'desc' },
        });

        let listMatch: { url: string; item: any } | null = null;

        for (const entry of entries) {
            try {
                const data = JSON.parse(entry.response);
                // Detail page match (top-level movie/TV object with credits, etc.)
                if ((data.id === id) && (data.title || data.name) && data.poster_path && data.credits) {
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
                        // TV specific
                        numberOfSeasons: data.number_of_seasons || null,
                        numberOfEpisodes: data.number_of_episodes || null,
                        seasons: (data.seasons || []).map((s: any) => ({
                            ...s,
                            posterPath: img('w154', s.poster_path),
                        })),
                        networks: data.networks || null,
                        createdBy: data.created_by || null,
                        // Cast (top 12)
                        cast: (data.credits?.cast || []).slice(0, 12).map((c: any) => ({
                            id: c.id, name: c.name, character: c.character,
                            profilePath: img('w185', c.profile_path),
                        })),
                        // Backdrops (top 6)
                        backdrops: (data.images?.backdrops || []).slice(0, 6).map((b: any) =>
                            img('w780', b.file_path)
                        ),
                        // Logo (prefer zh > en > any)
                        logoPath: (() => {
                            const logos = data.images?.logos || [];
                            const zh = logos.find((l: any) => l.iso_639_1 === 'zh');
                            if (zh) return img('w500', zh.file_path);
                            const en = logos.find((l: any) => l.iso_639_1 === 'en');
                            if (en) return img('w500', en.file_path);
                            return logos[0] ? img('w500', logos[0].file_path) : null;
                        })(),
                        // Videos (trailers, first 3)
                        videos: (data.videos?.results || [])
                            .filter((v: any) => v.site === 'YouTube')
                            .slice(0, 3)
                            .map((v: any) => ({ key: v.key, name: v.name, type: v.type })),
                        // Recommendations (top 8)
                        recommendations: (data.recommendations?.results || []).slice(0, 8).map((r: any) => ({
                            tmdbId: r.id, title: r.title || r.name,
                            posterPath: img('w300', r.poster_path),
                        })),
                        // Watch providers
                        watchProviders: data['watch/providers']?.results || null,
                    };
                }
            } catch { /* skip */ }
        }

        // Save partial match from list pages (don't return yet — try TMDB fallback first)
        let partialResult: any = null;
        for (const entry of entries) {
            try {
                const data = JSON.parse(entry.response);
                if (!Array.isArray(data.results)) continue;
                const found = data.results.find((r: any) => r.id === id);
                if (found && found.poster_path) {
                    const isMovie = !!(found.title || found.release_date);
                    partialResult = {
                        type: isMovie ? 'movie' : 'tv',
                        tmdbId: found.id,
                        title: isMovie ? found.title : found.name,
                        originalTitle: isMovie ? found.original_title : found.original_name,
                        overview: found.overview || '',
                        posterPath: img('w500', found.poster_path),
                        backdropPath: img('w780', found.backdrop_path),
                        voteAverage: found.vote_average ?? 0,
                        voteCount: found.vote_count ?? 0,
                        releaseDate: isMovie ? found.release_date : found.first_air_date,
                        runtime: null, genres: [], tagline: '', status: '',
                        budget: 0, revenue: 0, homepage: '', imdbId: '',
                        originalLanguage: found.original_language || '',
                        productionCompanies: [],
                        numberOfSeasons: null, numberOfEpisodes: null,
                        seasons: null, networks: null, createdBy: null,
                        cast: [], backdrops: [], logoPath: null, videos: [], recommendations: [],
                        watchProviders: null,
                        _partial: true,
                    };
                    break;
                }
            } catch { /* skip */ }
        }

        // Full detail not in cache — fetch from TMDB (auto-caches), then retry
        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const apiKey = config.tmdb.apiKey;
            const lang = config.tmdb.language;
            // Try movie first, then TV
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
                // Retry cache lookup (same logic as above)
                const retryEntries = await prisma.tmdbCache.findMany({
                    select: { url: true, response: true },
                    orderBy: { updatedAt: 'desc' },
                });
                for (const entry of retryEntries) {
                    try {
                        const data = JSON.parse(entry.response);
                        if ((data.id === id) && (data.title || data.name) && data.poster_path && data.credits) {
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
                    } catch { /* skip */ }
                }
            }
        } catch {}

        // Return partial result if available
        if (partialResult) return partialResult;

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
        const query = request.query as { type?: string; genre?: string };
        const type = query.type === 'tv' ? 'tv' : 'movie';
        const genre = query.genre;
        if (!genre) return { results: [] };

        const apiKey = config.tmdb.apiKey;
        const lang = config.tmdb.language;
        const forceProxy = true;

        try {
            const { handleTmdbRequest } = await import('./proxy.js');
            const urlPath = `3/discover/${type}?api_key=${apiKey}&language=${lang}&with_genres=${genre}&sort_by=popularity.desc&page=1`;
            const data = await handleTmdbRequest(urlPath, true);

            const results = (data.results || []).filter((item: any) => item.poster_path).map((item: any) => ({
                tmdbId: item.id,
                title: type === 'movie' ? item.title : item.name,
                posterPath: imgUrl('w300', item.poster_path, forceProxy),
                voteAverage: item.vote_average ?? 0,
                releaseDate: (type === 'movie' ? item.release_date : item.first_air_date) || '',
            }));

            return { results };
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
        };
    });

    // PUT /admin/api/config - Update config
    fastify.put('/admin/api/config', async (request, reply) => {
        const body = request.body as {
            tmdb?: { apiKey?: string; language?: string; httpProxy?: string; authKey?: string; proxyImages?: boolean; resolveTmdbDns?: boolean };
            server?: { port?: number };
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
        const configPath = path.resolve(process.cwd(), 'config.json');
        const tmpPath = configPath + '.tmp';
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2) + '\n');
            fs.renameSync(tmpPath, configPath);
            // Apply API key and language changes in-memory (port requires restart)
            const portChanged = newConfig.server.port !== config.server.port;
            updateConfig({ tmdb: { apiKey: newConfig.tmdb.apiKey, language: newConfig.tmdb.language, httpProxy: newConfig.tmdb.httpProxy, authKey: newConfig.tmdb.authKey, proxyImages: newConfig.tmdb.proxyImages, resolveTmdbDns: newConfig.tmdb.resolveTmdbDns } });
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