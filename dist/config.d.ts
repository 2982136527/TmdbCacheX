interface AppConfig {
    tmdb: {
        apiKey: string;
        proxyUrl: string;
        language: string;
        httpProxy: string;
        authKey: string;
        proxyImages: boolean;
        resolveTmdbDns: boolean;
    };
    server: {
        port: number;
    };
    logRetentionDays: number;
}
export declare function getConfigPath(): string;
export declare const config: AppConfig;
export declare function updateConfig(partial: {
    tmdb?: {
        apiKey?: string;
        language?: string;
        httpProxy?: string;
        authKey?: string;
        proxyImages?: boolean;
        resolveTmdbDns?: boolean;
    };
    logRetentionDays?: number;
}): void;
export {};
//# sourceMappingURL=config.d.ts.map