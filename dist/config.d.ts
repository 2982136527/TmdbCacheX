interface AppConfig {
    tmdb: {
        apiKey: string;
        proxyUrl: string;
        language: string;
        httpProxy: string;
        authKey: string;
        proxyImages: boolean;
    };
    server: {
        port: number;
    };
    logRetentionDays: number;
}
export declare const config: AppConfig;
export declare function updateConfig(partial: {
    tmdb?: {
        apiKey?: string;
        language?: string;
        httpProxy?: string;
        authKey?: string;
        proxyImages?: boolean;
    };
    logRetentionDays?: number;
}): void;
export {};
//# sourceMappingURL=config.d.ts.map