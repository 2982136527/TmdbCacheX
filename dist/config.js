import * as fs from 'fs';
import * as path from 'path';
const PLACEHOLDER_VALUES = ['YOUR_TMDB_API_KEY_HERE', '', 'your_key_here'];
export function getConfigPath() {
    return process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');
}
function loadConfig() {
    const configPath = getConfigPath();
    if (!fs.existsSync(configPath)) {
        console.warn('⚠️  config.json not found — creating default config.');
        const examplePath = path.resolve(process.cwd(), 'config.example.json');
        if (fs.existsSync(examplePath)) {
            fs.copyFileSync(examplePath, configPath);
        }
        else {
            fs.writeFileSync(configPath, JSON.stringify({ tmdb: { apiKey: '', language: 'zh-CN' }, server: { port: 3333 } }, null, 2));
        }
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    catch (e) {
        console.error(`❌ Failed to parse config.json: ${e.message}`);
        process.exit(1);
    }
    let apiKey = raw?.tmdb?.apiKey || '';
    if (!apiKey || PLACEHOLDER_VALUES.includes(apiKey)) {
        console.warn('⚠️  TMDB API key not configured — please set it in the admin panel.');
        apiKey = '';
    }
    const config = {
        tmdb: {
            apiKey,
            proxyUrl: raw.tmdb?.proxyUrl || 'https://api.themoviedb.org',
            language: raw.tmdb?.language || 'zh-CN',
            httpProxy: raw.tmdb?.httpProxy || '',
            authKey: raw.tmdb?.authKey || '',
            proxyImages: raw.tmdb?.proxyImages !== false, // default true
            resolveTmdbDns: raw.tmdb?.resolveTmdbDns === true, // default false
        },
        server: {
            port: raw.server?.port || 3333,
        },
        logRetentionDays: raw.logRetentionDays ?? 7,
    };
    return config;
}
export const config = loadConfig();
export function updateConfig(partial) {
    if (partial.tmdb?.apiKey)
        config.tmdb.apiKey = partial.tmdb.apiKey;
    if (partial.tmdb?.language)
        config.tmdb.language = partial.tmdb.language;
    if (partial.tmdb?.httpProxy !== undefined)
        config.tmdb.httpProxy = partial.tmdb.httpProxy;
    if (partial.tmdb?.authKey !== undefined)
        config.tmdb.authKey = partial.tmdb.authKey;
    if (partial.tmdb?.proxyImages !== undefined)
        config.tmdb.proxyImages = partial.tmdb.proxyImages;
    if (partial.tmdb?.resolveTmdbDns !== undefined)
        config.tmdb.resolveTmdbDns = partial.tmdb.resolveTmdbDns;
    if (partial.logRetentionDays !== undefined)
        config.logRetentionDays = partial.logRetentionDays;
}
//# sourceMappingURL=config.js.map