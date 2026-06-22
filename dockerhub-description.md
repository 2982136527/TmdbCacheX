# TmdbCacheX

高性能 TMDB 缓存代理服务器，自动缓存 TMDB API 响应到本地 SQLite 数据库，减少上游请求频率，提升媒体服务器刮削速度。

## 功能特性

- **缓存代理** — 代理 TMDB API 请求，自动缓存响应
- **自动丰富** — 详情页自动附带 credits、images、videos 等数据
- **预取机制** — 自动在后台预取关联数据
- **Cache Warmer** — 自动巡航模式，定期爬取热门内容
- **管理后台** — 内置 Web 管理界面，支持缓存预览、配置管理、Warmer 控制、调用日志
- **特效工坊** — 管理后台内置视觉特效面板：果冻模式、炫光模式、屏幕震动、3D 倾斜、CRT 扫描线、樱花飘落
- **图片代理** — 支持 `/img/*` 和 `/t/p/*` 两种路径（兼容 Emby 插件）
- **DNS 覆盖** — 适用于 DNS 污染环境
- **API 鉴权** — 支持自定义 authKey

## 快速开始

```bash
docker run -d \
  --name tmdbcachex \
  -p 3333:3333 \
  -v /你的数据目录:/app/data \
  qiuhusama/tmdbcachex:latest
```

启动后访问 `http://IP:3333`，在管理后台配置 TMDB API Key 即可使用。

## 数据目录

映射 `/app/data` 目录，自动管理：
- `config.json` — 配置文件（首次运行自动生成）
- `db/dev.db` — SQLite 数据库

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CONFIG_PATH` | 配置文件路径 | `/app/data/config.json` |
| `DATABASE_URL` | 数据库路径 | `file:./prisma/dev.db` |

## 支持平台

- `linux/amd64` (x86_64)
- `linux/arm64` (ARM64)

## 对接媒体服务器

代理完全保留 TMDB 的 URL 结构：

| 原始请求 | 代理请求 |
|----------|----------|
| `https://api.themoviedb.org/3/movie/550?api_key=xxx` | `http://你的IP:3333/3/movie/550?api_key=xxx` |

## GitHub

[2982136527/TmdbCacheX](https://github.com/2982136527/TmdbCacheX)
