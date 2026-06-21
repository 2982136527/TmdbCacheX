
import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { handleTmdbRequest, prisma, getProxyConfig } from './proxy.js';
import { config } from './config.js';
import { adminRoutes } from './admin.js';
import { getDnsAgent } from './dns-resolver.js';

function parseApiType(url: string): string {
    if (/\/movie\/\d+/.test(url)) return 'movie';
    if (/\/tv\/\d+/.test(url)) return 'tv';
    if (/\/person\/\d+/.test(url)) return 'person';
    if (/\/(popular|top_rated|now_playing|on_the_air|airing_today|trending|discover)/.test(url)) return 'list';
    return 'other';
}

// Custom logger that suppresses admin/static/image proxy request logs
const isNoisyUrl = (url: string) =>
    url.startsWith('/admin/api') || url.startsWith('/img/') || url.startsWith('/t/p/') || url === '/';

const fastify = Fastify({
    logger: true,
    disableRequestLogging: true,
});

const PORT = config.server.port;

// Selective request logging: skip admin/static/image routes
fastify.addHook('onRequest', async (request) => {
    if (!isNoisyUrl(request.url)) {
        request.log.info({ req: request }, 'incoming request');
    }
});
fastify.addHook('onResponse', async (request, reply) => {
    if (!isNoisyUrl(request.url)) {
        request.log.info({ res: reply, responseTime: (reply as any).elapsedTime }, 'request completed');
    }
});

// Serve admin page at /
fastify.get('/', async (request, reply) => {
    const htmlPath = path.join(process.cwd(), 'public', 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    reply.type('text/html').send(html);
});

// Shared warmer reference for admin API
let warmerInstance: any = null;

// Register admin API routes (before catch-all)
fastify.register(adminRoutes, { getWarmer: () => warmerInstance });

// Allowed TMDB API path patterns
const ALLOWED_PATHS = /^\/3\/(movie|tv|search|discover|trending|genre|configuration|find|person|collection|network|company|keyword|review|account|authentication|certification|changes|lists)(\/|$)/;

// In-memory image cache (LRU-ish, max 500 entries, 7 day TTL)
const imageCache = new Map<string, { data: Buffer; contentType: string; cachedAt: number }>();
const IMAGE_CACHE_TTL = 7 * 24 * 3600 * 1000;
const IMAGE_CACHE_MAX = 500;

// Shared image proxy handler (supports both /img/* and /t/p/* for TMDB image compatibility)
async function proxyImage(imgPath: string, reply: any) {
    if (!imgPath || !imgPath.startsWith('/')) {
        reply.code(400).send({ error: 'Invalid image path' });
        return;
    }

    // Check in-memory cache
    const cached = imageCache.get(imgPath);
    if (cached && Date.now() - cached.cachedAt < IMAGE_CACHE_TTL) {
        reply
            .header('Content-Type', cached.contentType)
            .header('Cache-Control', 'public, max-age=604800')
            .header('X-Cache', 'HIT')
            .send(cached.data);
        return;
    }

    try {
        const { default: axios } = await import('axios');
        const proxyCfg = getProxyConfig();
        const dnsConfig = config.tmdb.resolveTmdbDns ? { httpsAgent: getDnsAgent() } : {};
        const maxRetries = 99;
        let lastError: any;
        let response: any;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                response = await axios.get(`https://image.tmdb.org/t/p${imgPath}`, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: { 'User-Agent': 'TmdbCacheX/1.0' },
                    ...proxyCfg,
                    ...dnsConfig,
                });
                break;
            } catch (err: any) {
                lastError = err;
                const code = err.code || '';
                const isRetryable = !err.response?.status || err.response.status >= 500
                    || code === 'ECONNRESET' || code === 'ECONNABORTED'
                    || err.message?.includes('TLS') || err.message?.includes('socket');

                if (attempt < maxRetries && isRetryable) {
                    const delay = Math.min((attempt + 1) * 1500, 30000);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    throw lastError;
                }
            }
        }

        const contentType = response.headers['content-type'] || 'image/jpeg';
        const data = Buffer.from(response.data);

        // Store in cache (evict oldest if full)
        if (imageCache.size >= IMAGE_CACHE_MAX) {
            const firstKey = imageCache.keys().next().value;
            if (firstKey) imageCache.delete(firstKey);
        }
        imageCache.set(imgPath, { data, contentType, cachedAt: Date.now() });

        reply
            .header('Content-Type', contentType)
            .header('Cache-Control', 'public, max-age=604800')
            .header('X-Cache', 'MISS')
            .send(data);
    } catch (e: any) {
        reply.code(e.response?.status || 502).send({ error: 'Image fetch failed' });
    }
}

// Image proxy via /img/* (admin UI and custom clients)
fastify.get('/img/*', async (request, reply) => {
    await proxyImage(request.url.substring(4), reply);
});

// Image proxy via /t/p/* (compatible with Emby plugins like StrmAssistant)
fastify.get('/t/p/*', async (request, reply) => {
    await proxyImage(request.url.substring(4), reply); // remove "/t/p", keep leading "/"
});

// Catch-all route for TMDB proxy
fastify.get('/*', async (request, reply) => {
    const url = request.url.substring(1);
    if (!url) {
        return { message: "TMDB Cache Proxy Running. Use paths like /3/movie/..." };
    }

    // Validate path against allowlist (strip query params for matching)
    const urlPath = url.split('?')[0];
    if (!ALLOWED_PATHS.test('/' + urlPath)) {
        reply.code(400).send({ error: 'Invalid API path' });
        return;
    }

    // Detect internal vs external
    const referer = request.headers.referer || '';
    const clientIp = request.ip || request.socket.remoteAddress || '';
    const ua = request.headers['user-agent'] || '';
    const isInternal = referer.includes('/admin') || (clientIp === '127.0.0.1' && referer.includes('localhost'));

    try {
        const data = await handleTmdbRequest(url);
        // Log API call (fire and forget)
        if (!isInternal) {
            const title = data?.title || data?.name || data?.results?.[0]?.title || data?.results?.[0]?.name || null;
            prisma.apiLog.create({
                data: {
                    url: url.split('?')[0] || '',
                    title: title ? String(title).substring(0, 200) : null,
                    type: parseApiType(url),
                    source: 'external',
                    hit: true,
                    ip: clientIp,
                    ua: ua.substring(0, 300),
                }
            }).catch(() => {});
        }
        return data;
    } catch (err: any) {
        // Classify error type for better diagnostics
        let status: number;
        let errorMsg: string;
        const errCode = err.code || '';

        if (err.response?.status) {
            // Upstream TMDB returned an error response
            status = err.response.status;
            errorMsg = status === 404 ? 'Resource not found'
                     : status === 429 ? 'Rate limited by upstream'
                     : `Upstream error ${status}`;
        } else if (errCode === 'ECONNABORTED' || err.message?.includes('timeout')) {
            status = 504; errorMsg = 'Upstream timeout';
        } else if (errCode === 'ENOTFOUND' || errCode === 'EAI_AGAIN') {
            status = 502; errorMsg = 'DNS resolution failed';
        } else if (errCode === 'ECONNREFUSED' || errCode === 'ECONNRESET' || errCode === 'EHOSTUNREACH') {
            status = 502; errorMsg = 'Upstream unreachable';
        } else {
            status = 500; errorMsg = 'Internal error';
        }

        const logTag = `[${status}] ${errorMsg}`;
        if (status === 404) request.log.warn(`${logTag}: ${url}`);
        else request.log.error(`${logTag}: ${url} (${errCode || err.message})`);

        // Log failed external calls
        if (!isInternal) {
            prisma.apiLog.create({
                data: {
                    url: url.split('?')[0] || '',
                    title: null,
                    type: parseApiType(url),
                    source: 'external',
                    hit: false,
                    ip: clientIp,
                    ua: ua.substring(0, 300),
                }
            }).catch(() => {});
        }
        reply.code(status).send({ error: errorMsg });
    }
});

// Graceful shutdown
async function shutdown() {
    console.log('\n[SERVER] Shutting down gracefully...');
    try {
        if (warmerInstance) warmerInstance.stop();
        await prisma.$disconnect();
        await fastify.close();
        console.log('[SERVER] Shutdown complete.');
    } catch (e) {
        console.error('[SERVER] Error during shutdown:', e);
    }
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Server listening on http://localhost:${PORT}`);

        // Start Cache Warmer (Auto-Pilot)
        const { CacheWarmer } = await import('./cache-warmer.js');
        warmerInstance = new CacheWarmer();
        warmerInstance.start();

    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();
