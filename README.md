![alt text](QQ_1766899956347.png)

# TmdbCacheX

TmdbCacheX 是一个基于 Node.js、Fastify 和 Prisma (SQLite) 构建的高性能 TMDB 缓存代理服务器。它会自动缓存 TMDB API 响应到本地数据库，减少对上游的请求频率，提升媒体服务器的刮削速度。

## 功能特性

- **缓存代理** — 代理 TMDB API 请求，自动缓存响应到 SQLite，后续请求直接从本地读取
- **自动丰富** — 电影/剧集详情页自动附带 credits、images、videos 等数据，人物页自动附带作品列表
- **预取机制** — 请求列表页或详情页时，自动在后台预取关联数据（推荐、相似、合集等）
- **Cache Warmer** — 自动巡航模式，定期爬取热门内容填充缓存
- **管理后台** — 内置 Web 管理界面，支持缓存预览、配置管理、调用日志、API 测试
- **图片代理** — 代理 TMDB 图片请求，支持 `/img/*` 和 `/t/p/*` 两种路径（兼容 Emby 插件）
- **DNS 覆盖** — 通过外部 DNS 解析 TMDB 域名，适用于 DNS 污染环境
- **API 鉴权** — 支持自定义 authKey，防止未授权访问

## 快速开始

### 安装

```bash
git clone https://github.com/2982136527/TmdbCacheX.git
cd TmdbCacheX
npm install
npx prisma generate
```

### 配置

首次运行后会在根目录生成 `config.json`，也可通过管理后台在线修改：

```json
{
  "tmdb": {
    "apiKey": "你的 TMDB API Key",
    "language": "zh-CN",
    "httpProxy": "",
    "authKey": "",
    "proxyImages": true,
    "resolveTmdbDns": false
  },
  "server": {
    "port": 3333
  }
}
```

| 字段 | 说明 |
|------|------|
| `apiKey` | TMDB API Key（必填） |
| `language` | 返回语言，默认 `zh-CN` |
| `httpProxy` | HTTP 代理地址，如 `http://127.0.0.1:7890`（可选） |
| `authKey` | 自定义鉴权密钥，客户端需传入 `api_key=你的authKey`（可选） |
| `proxyImages` | 是否代理图片请求 |
| `resolveTmdbDns` | 是否启用 DNS 覆盖（适用于 DNS 污染环境） |

### 数据库

本仓库不包含缓存数据库文件。如需使用预填充数据：

1. 前往 [Releases](https://github.com/2982136527/TmdbCacheX/releases) 页面下载 `db_archive.zip`
2. 解压到 `prisma/prisma/dev.db`（Prisma 相对路径解析机制决定的实际位置）

### 启动

```bash
# 开发模式（热重载）
npm run dev

# 生产环境
npm run start
```

启动后访问 `http://localhost:3333` 打开管理后台。

## 对接媒体服务器

代理完全保留 TMDB 的 URL 结构，只需将 API 地址指向本服务：

| 原始请求 | 代理请求 |
|----------|----------|
| `https://api.themoviedb.org/3/movie/550?api_key=xxx` | `http://你的IP:3333/3/movie/550?api_key=xxx` |

支持的 API 端点：`movie`、`tv`、`search`、`discover`、`trending`、`genre`、`person`、`collection`、`find`、`configuration` 等。

图片代理：
- `/t/p/w500/path/to/poster.jpg` — 兼容 Emby 插件（如 StrmAssistant）
- `/img/w500/path/to/poster.jpg` — 自定义路径

## 其他脚本

| 命令 | 说明 |
|------|------|
| `npm run prefetch` | 运行预取脚本填充缓存 |
| `npm run simulate` | 运行模拟脚本 |
| `npm run scrape` | 运行爬虫脚本 |
| `npm run db:studio` | 打开 Prisma Studio 查看数据库 |

## License

ISC
