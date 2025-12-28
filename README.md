![alt text](QQ_1766899956347.png)# TmdbCacheX

TmdbCacheX 是一个基于 Node.js, Fastify 和 Prisma (SQLite) 构建的高性能 TMDB (The Movie Database) 缓存代理服务器。它的设计目的是为了缓存 TMDB API 的响应，从而减少对 TMDB 的请求频率（避免速率限制）并提高媒体服务器应用程序的响应速度。

> **⚠️ 注意**：本项目目前仍处于早期开发阶段，功能不够完善。**数据库缓存数据可能存在遗漏**，这可能会导致刮削结果不全或部分元数据缺失。

## 功能特性 (Features)

*   **缓存代理 (Caching Proxy)**: 代理对 TMDB 的请求，并将响应结果缓存到本地 SQLite 数据库中。
*   **数据库模拟 (Database Simulation)**: 可以直接从数据库提供缓存的数据，完全无需访问 TMDB API。
*   **预取 (Prefetching)**: 包含预取脚本，用于提前获取热门电影和电视剧的数据。
*   **Studio 验证**: 提供工具来验证和模拟数据库中的条目。

## 安装 (Installation)

1.  克隆仓库:
    ```bash
    git clone <你的仓库地址>
    cd TmdbCacheX
    ```

2.  安装依赖:
    ```bash
    npm install
    ```

## 配置 (Configuration)

1.  在根目录下创建一个 `.env` 文件 (可以参考示例文件，或者直接使用下面的模板):

    ```env
    DATABASE_URL="file:./prisma/dev.db"
    TMDB_API_KEY="你的_TMDB_API_KEY"
    TMDB_PROXY_URL="http://你的代理地址_如果有的话"
    ```

    *   `DATABASE_URL`: SQLite 数据库文件的路径。建议保留为 `prisma/dev.db`。
    *   `TMDB_API_KEY`: 你的 TMDB API 读取访问令牌或 API Key。
    *   `TMDB_PROXY_URL`: (可选) 用于 TMDB 请求的代理服务器 URL。

## 数据库设置 (重要)

**本仓库不包含用于缓存数据的数据库文件 (`dev.db`)。**

如果您想使用预先填充好数据的缓存数据库，请执行以下操作：

1.  前往本 GitHub 仓库的 **Releases (发行版)** 页面。
2.  在最新的 Release 中下载 `db_archive.zip` 压缩包。
3.  解压 `db_archive.zip` 到项目根目录。解压后，数据库文件应该会自动出现在 `prisma/dev.db`。
4.  确保你的 `.env` 文件指向了这个位置:
    ```env
    DATABASE_URL="file:./prisma/dev.db"
    ```

## 使用方法 (Usage)

### 开发服务器 (Development)
启动带有热重载功能的开发服务器:
```bash
npm run dev
```

### 生产环境启动 (Production)
编译并启动服务器:
```bash
npm run start
```

### 其他脚本 (Scripts)
-   `npm run prefetch`: 运行预取脚本以填充缓存。
-   `npm run simulate`: 运行模拟脚本。
-   `npm run scrape`: 运行爬虫/抓取脚本。
-   `npm run db:studio`: 打开 Prisma Studio 图形化界面查看数据库。

## License

ISC
