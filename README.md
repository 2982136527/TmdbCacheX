# TmdbCacheX

TmdbCacheX is a high-performance TMDB (The Movie Database) caching proxy server built with Node.js, Fastify, and Prisma (SQLite). It is designed to cache TMDB API responses to reduce rate limiting and improve response times for media server applications.

## Features

*   **Caching Proxy**: Proxies requests to TMDB and caches the responses in a local SQLite database.
*   **Database Simulation**: Can serve cached data directly from the database without hitting the TMDB API.
*   **Prefetching**: Includes scripts to prefetch data for popular movies and TV shows.
*   **Studio Verification**: Tools to verify and simulate database entries.

## Installation

1.  Clone the repository:
    ```bash
    git clone <your-repo-url>
    cd TmdbCacheX
    ```

2.  Install dependencies:
    ```bash
    npm install
    ```

## Configuration

1.  Create a `.env` file in the root directory (copy from example if available, or use the template below):

    ```env
    DATABASE_URL="file:./prisma/dev.db"
    TMDB_API_KEY="your_tmdb_api_key_here"
    TMDB_PROXY_URL="http://your_proxy_url_if_needed"
    ```

    *   `DATABASE_URL`: Path to the SQLite database file. Ideally, keep it in `prisma/dev.db`.
    *   `TMDB_API_KEY`: Your TMDB API Read Access Token or API Key.
    *   `TMDB_PROXY_URL`: (Optional) Proxy URL for outbound TMDB requests.

## Database Setup (Important)

**This repository does not include the database file (`dev.db`) used for caching.**

To use the pre-filled cache database:

1.  Go to the **Releases** page of this GitHub repository.
2.  Download the `dev.db` file from the latest release assets.
3.  Place the `dev.db` file into the `prisma/` folder of this project:
    ```
    TmdbCacheX/prisma/dev.db
    ```
4.  Ensure your `.env` file points to this location:
    ```env
    DATABASE_URL="file:./prisma/dev.db"
    ```

## Usage

### Development Server
Run the server with hot-reloading:
```bash
npm run dev
```

### Production Start
Build and start the server:
```bash
npm run start
```

### Other Scripts
-   `npm run prefetch`: Run the prefetch script to populate the cache.
-   `npm run simulate`: Run the simulation script.
-   `npm run scrape`: Run the scraper.
-   `npm run db:studio`: Open Prisma Studio to inspect the database.

## License

ISC
