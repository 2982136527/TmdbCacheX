import { PrismaClient } from '@prisma/client';
export declare const prisma: PrismaClient<import("@prisma/client").Prisma.PrismaClientOptions, never, import("@prisma/client/runtime/library").DefaultArgs>;
export declare function getProxyConfig(): {
    proxy?: {
        host: string;
        port: number;
        protocol: string;
    };
};
export declare function handleTmdbRequest(urlPath: string, isBackground?: boolean): Promise<any>;
//# sourceMappingURL=proxy.d.ts.map