import https from 'https';
export declare function getDnsAgent(): https.Agent;
export declare function testDnsConnectivity(): Promise<{
    dnsReachable: boolean;
    dnsLatency: number;
    resolveSuccess: boolean;
    resolveLatency: number;
    resolvedIp: string | null;
    httpsSuccess: boolean;
    httpsLatency: number;
    error?: string;
}>;
//# sourceMappingURL=dns-resolver.d.ts.map