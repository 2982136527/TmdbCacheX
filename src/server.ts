
import Fastify from 'fastify';
import fs from 'fs';
import path from 'path';
import { handleTmdbRequest, prisma } from './proxy.js';
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

const fastify = Fastify({
    logger: true
});

const PORT = config.server.port;

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

// Shared image proxy handler (supports both /img/* and /t/p/* for TMDB image compatibility)
async function proxyImage(imgPath: string, reply: any) {
    if (!imgPath || !imgPath.startsWith('/')) {
        reply.code(400).send({ error: 'Invalid image path' });
        return;
    }
    try {
        const { default: axios } = await import('axios');
        const proxyCfg = config.tmdb.httpProxy ? (() => {
            try {
                const url = new URL(config.tmdb.httpProxy);
                return { proxy: { host: url.hostname, port: parseInt(url.port) || 80, protocol: url.protocol.replace(':', '') } };
            } catch { return {}; }
        })() : {};
        const dnsConfig = config.tmdb.resolveTmdbDns ? { httpsAgent: getDnsAgent() } : {};
        const response = await axios.get(`https://image.tmdb.org/t/p${imgPath}`, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: { 'User-Agent': 'TmdbCacheX/1.0' },
            ...proxyCfg,
            ...dnsConfig,
        });
        reply
            .header('Content-Type', response.headers['content-type'] || 'image/jpeg')
            .header('Cache-Control', 'public, max-age=604800') // 7 days
            .send(response.data);
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
        const status = err.response?.status || 500;
        if (status === 404) {
            request.log.warn(`[404] Resource not found: ${url}`);
        } else {
            request.log.error(`[ERROR] Upstream request failed with status ${status}`);
        }
        // Log failed external calls too
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
        if (status === 404) {
            reply.code(404).send({ error: 'Resource not found' });
        } else if (status === 429) {
            reply.code(429).send({ error: 'Rate limited by upstream' });
        } else {
            reply.code(status).send({ error: 'Upstream request failed' });
        }
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
