import dns, { Resolver } from 'dns';
import https from 'https';
import tls from 'tls';
import net from 'net';
import { config } from './config.js';
const DNS_SERVERS = ['8.8.8.8', '1.1.1.1'];
const TMDB_HOSTS = ['api.themoviedb.org', 'image.tmdb.org'];
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const dnsCache = new Map();
function createResolver() {
    const resolver = new Resolver();
    resolver.setServers(DNS_SERVERS);
    return resolver;
}
function resolveHost(hostname) {
    return new Promise((resolve, reject) => {
        const cached = dnsCache.get(hostname);
        if (cached && cached.expiresAt > Date.now()) {
            return resolve(cached.ip);
        }
        const resolver = createResolver();
        resolver.resolve4(hostname, (err, addresses) => {
            if (err || !addresses.length) {
                return reject(err || new Error(`No addresses found for ${hostname}`));
            }
            const ip = addresses[0];
            dnsCache.set(hostname, { ip, expiresAt: Date.now() + CACHE_TTL_MS });
            resolve(ip);
        });
    });
}
function createDnsAgent() {
    const agent = new https.Agent({ keepAlive: true });
    agent.createConnection = (options, callback) => {
        const hostname = options.hostname || options.host;
        if (!TMDB_HOSTS.includes(hostname)) {
            // Default connection for non-TMDB domains
            const socket = tls.connect(options, () => callback(null, socket));
            socket.on('error', (err) => callback(err));
            return socket;
        }
        resolveHost(hostname)
            .then(ip => {
            const connOptions = {
                ...options,
                host: ip,
                servername: hostname, // SNI
            };
            const socket = tls.connect(connOptions, () => callback(null, socket));
            socket.on('error', (err) => callback(err));
        })
            .catch(err => {
            // Fall back to default DNS
            const socket = tls.connect(options, () => callback(null, socket));
            socket.on('error', (err2) => callback(err2));
        });
    };
    return agent;
}
let cachedAgent = null;
export function getDnsAgent() {
    if (!cachedAgent) {
        cachedAgent = createDnsAgent();
    }
    return cachedAgent;
}
export async function testDnsConnectivity() {
    const result = {
        dnsReachable: false,
        dnsLatency: 0,
        resolveSuccess: false,
        resolveLatency: 0,
        resolvedIp: null,
        httpsSuccess: false,
        httpsLatency: 0,
    };
    // Step 1: Test DNS server connectivity
    const dnsStart = Date.now();
    try {
        const resolver = createResolver();
        await new Promise((resolve, reject) => {
            resolver.resolve4('google.com', (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
        result.dnsReachable = true;
        result.dnsLatency = Date.now() - dnsStart;
    }
    catch (e) {
        result.dnsLatency = Date.now() - dnsStart;
        result.error = `DNS 服务器不可达: ${e.message}`;
        return result;
    }
    // Step 2: Resolve TMDB domain
    const resolveStart = Date.now();
    try {
        const ip = await resolveHost('api.themoviedb.org');
        result.resolveSuccess = true;
        result.resolveLatency = Date.now() - resolveStart;
        result.resolvedIp = ip;
    }
    catch (e) {
        result.resolveLatency = Date.now() - resolveStart;
        result.error = `DNS 解析失败: ${e.message}`;
        return result;
    }
    // Step 3: Test TCP connectivity to resolved IP
    const httpsStart = Date.now();
    try {
        await new Promise((resolve, reject) => {
            const socket = net.connect(443, result.resolvedIp, () => {
                result.httpsSuccess = true;
                result.httpsLatency = Date.now() - httpsStart;
                socket.destroy();
                resolve();
            });
            socket.on('error', (err) => {
                result.httpsLatency = Date.now() - httpsStart;
                reject(err);
            });
            socket.setTimeout(5000, () => {
                result.httpsLatency = Date.now() - httpsStart;
                socket.destroy();
                reject(new Error('Connection timeout'));
            });
        });
    }
    catch (e) {
        result.httpsLatency = Date.now() - httpsStart;
        result.error = `连接失败: ${e.message}`;
    }
    return result;
}
//# sourceMappingURL=dns-resolver.js.map