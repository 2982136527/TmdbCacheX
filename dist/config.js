import * as fs from 'fs';
import * as path from 'path';
const CONFIG_FILE = 'config.json';
const PLACEHOLDER_VALUES = ['YOUR_TMDB_API_KEY_HERE', '', 'your_key_here'];
function loadConfig() {
    const configPath = path.resolve(process.cwd(), CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
        console.error('❌ Configuration file not found: config.json');
        console.error('   Please copy config.example.json to config.json and fill in your TMDB API key.');
        console.error('   Example: cp config.example.json config.json');
        process.exit(1);
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    catch (e) {
        console.error(`❌ Failed to parse config.json: ${e.message}`);
        process.exit(1);
    }
    const apiKey = raw?.tmdb?.apiKey;
    if (!apiKey || PLACEHOLDER_VALUES.includes(apiKey)) {
        console.error('❌ TMDB API key is missing or still set to placeholder value in config.json.');
        console.error('   Please edit config.json and set tmdb.apiKey to your actual TMDB API key.');
        process.exit(1);
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