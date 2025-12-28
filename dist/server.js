import Fastify from 'fastify';
import { handleTmdbRequest } from './proxy.js';
import dotenv from 'dotenv';
dotenv.config();
const fastify = Fastify({
    logger: true
});
const PORT = 3333;
// Catch-all route for TMDB proxy
fastify.get('/*', async (request, reply) => {
    // strip the leading slash
    const url = request.url.substring(1);
    if (!url) {
        return { message: "TMDB Cache Proxy Running. Use paths like /3/movie/..." };
    }
    try {
        const data = await handleTmdbRequest(url);
        return data;
    }
    catch (err) {
        request.log.error(err);
        reply.code(err.response?.status || 500).send(err.response?.data || { error: 'Internal Server Error' });
    }
});
const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log(`Server listening on http://localhost:${PORT}`);
        // Start Cache Warmer (Auto-Pilot)
        const { CacheWarmer } = await import('./cache-warmer.js');
        const warmer = new CacheWarmer();
        warmer.start();
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
//# sourceMappingURL=server.js.map