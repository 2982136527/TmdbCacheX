import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const fastify = Fastify({ logger: true });
const PORT = 3334;
const HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TMDB Cache Viewer</title>
    <style>
        :root {
            --bg-color: #0f172a;
            --card-bg: rgba(30, 41, 59, 0.7);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --accent: #38bdf8;
            --border: rgba(148, 163, 184, 0.1);
        }

        body {
            font-family: 'Inter', -apple-system, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-primary);
            margin: 0;
            padding: 20px;
            min-height: 100vh;
            background-image: 
                radial-gradient(at 0% 0%, rgba(56, 189, 248, 0.1) 0px, transparent 50%),
                radial-gradient(at 100% 0%, rgba(139, 92, 246, 0.1) 0px, transparent 50%);
        }

        .container { max-width: 1200px; margin: 0 auto; }

        header {
            margin-bottom: 40px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 20px;
            background: var(--card-bg);
            backdrop-filter: blur(12px);
            border-radius: 16px;
            border: 1px solid var(--border);
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }

        h1 {
            margin: 0;
            font-size: 1.5rem;
            font-weight: 700;
            background: linear-gradient(to right, #38bdf8, #818cf8);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .stats { color: var(--text-secondary); font-size: 0.9rem; }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 24px;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--border);
            border-radius: 16px;
            overflow: hidden;
            transition: transform 0.2s, box-shadow 0.2s;
            cursor: pointer;
        }

        .card:hover {
            transform: translateY(-4px);
            box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2);
            border-color: rgba(56, 189, 248, 0.3);
        }

        .card-image {
            width: 100%;
            height: 180px;
            object-fit: cover;
            background: #1e293b;
        }

        .card-content { padding: 16px; }

        .card-title {
            font-weight: 600;
            font-size: 1.1rem;
            margin-bottom: 8px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .card-meta {
            display: flex;
            gap: 12px;
            font-size: 0.8rem;
            color: var(--text-secondary);
        }

        .tag {
            background: rgba(56, 189, 248, 0.1);
            color: var(--accent);
            padding: 2px 8px;
            border-radius: 4px;
        }

        .url-path {
            font-family: monospace;
            font-size: 0.75rem;
            color: var(--text-secondary);
            margin-top: 12px;
            word-break: break-all;
            opacity: 0.7;
        }

        .modal-overlay {
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            backdrop-filter: blur(4px);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 100;
            padding: 20px;
        }

        .modal {
            background: #1e293b;
            border-radius: 16px;
            width: 100%;
            max-width: 800px;
            max-height: 90vh;
            border: 1px solid var(--border);
            display: flex;
            flex-direction: column;
        }

        .modal-header {
            padding: 20px;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-body { padding: 20px; overflow-y: auto; }

        .json-viewer {
            background: #0f172a;
            padding: 16px;
            border-radius: 8px;
            font-family: monospace;
            font-size: 0.9rem;
            white-space: pre-wrap;
            color: #a5b4fc;
        }

        .close-btn {
            background: none;
            border: none;
            color: var(--text-secondary);
            cursor: pointer;
            font-size: 1.5rem;
        }

        .btn {
            background: var(--card-bg);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 8px 16px;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .btn:hover:not(:disabled) {
            background: var(--accent);
            color: #0f172a;
        }

        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div>
                <h1>TMDB Cache Explorer</h1>
                <div class="stats" id="total-count">Loading...</div>
            </div>
            <div style="display: flex; gap: 10px; align-items: center;">
                <button class="btn" id="prev-btn" onclick="loadData(currentPage - 1)">上一页</button>
                <span id="page-indicator">Page 1</span>
                <button class="btn" id="next-btn" onclick="loadData(currentPage + 1)">下一页</button>
            </div>
        </header>

        <div class="grid" id="grid"></div>
    </div>

    <div class="modal-overlay" id="modal" onclick="if(event.target === this) closeModal()">
        <div class="modal">
            <div class="modal-header">
                <h3 id="modal-title">Details</h3>
                <button class="close-btn" onclick="closeModal()">×</button>
            </div>
            <div class="modal-body">
                <p class="url-path" id="modal-url"></p>
                <div class="json-viewer" id="modal-json"></div>
            </div>
        </div>
    </div>

    <script>
        let currentPage = 1;
        const pageSize = 24;

        async function loadData(page) {
            if (page < 1) return;
            currentPage = page;
            document.getElementById('grid').innerHTML = '<div style="grid-column: 1/-1; text-align: center; padding: 40px;">Loading...</div>';

            try {
                const res = await fetch('/api/entries?page=' + page + '&limit=' + pageSize);
                const data = await res.json();
                renderGrid(data.items);
                updateUI(data.total, page);
            } catch (err) {
                document.getElementById('grid').innerHTML = '<div style="color: coral; text-align: center;">Error loading data</div>';
            }
        }

        function renderGrid(items) {
            const grid = document.getElementById('grid');
            grid.innerHTML = '';

            items.forEach(function(item) {
                let parsed = {};
                try { parsed = JSON.parse(item.response); } catch (e) { parsed = { error: "Invalid JSON" }; }

                const title = parsed.title || parsed.name || 'Unknown';
                const posterPath = parsed.poster_path || parsed.profile_path || parsed.still_path;
                const imageUrl = posterPath ? 'https://image.tmdb.org/t/p/w500' + posterPath : '';

                let type = 'Other';
                if (item.url.includes('/movie/')) type = 'Movie';
                else if (item.url.includes('/tv/')) type = 'TV';
                else if (item.url.includes('/person/')) type = 'Person';

                const card = document.createElement('div');
                card.className = 'card';
                card.onclick = function() { openModal(item, parsed); };
                
                let imageStyle = imageUrl 
                    ? "background-image: url('" + imageUrl + "'); background-size: cover; background-position: center;"
                    : "display:flex;align-items:center;justify-content:center;color:#475569;";
                
                card.innerHTML = 
                    '<div class="card-image" style="' + imageStyle + '">' +
                        (!imageUrl ? '<span>No Image</span>' : '') +
                    '</div>' +
                    '<div class="card-content">' +
                        '<div class="card-title" title="' + title + '">' + title + '</div>' +
                        '<div class="card-meta">' +
                            '<span class="tag">' + type + '</span>' +
                            '<span>ID: ' + (parsed.id || item.id) + '</span>' +
                        '</div>' +
                        '<div class="url-path">' + item.url.split('?')[0] + '</div>' +
                    '</div>';
                grid.appendChild(card);
            });
        }

        function updateUI(total, page) {
            document.getElementById('total-count').textContent = '共 ' + total + ' 条缓存';
            document.getElementById('page-indicator').textContent = 'Page ' + page;
            document.getElementById('prev-btn').disabled = page === 1;
        }

        function openModal(item, parsed) {
            document.getElementById('modal').style.display = 'flex';
            document.getElementById('modal-title').textContent = parsed.title || parsed.name || 'Details';
            document.getElementById('modal-url').textContent = item.url;
            document.getElementById('modal-json').textContent = JSON.stringify(parsed, null, 2);
        }

        function closeModal() {
            document.getElementById('modal').style.display = 'none';
        }

        loadData(1);
    </script>
</body>
</html>
`;
fastify.get('/', async (req, reply) => {
    reply.type('text/html').send(HTML_TEMPLATE);
});
fastify.get('/api/entries', async (req, reply) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 24;
    const skip = (page - 1) * limit;
    try {
        const [total, items] = await Promise.all([
            prisma.tmdbCache.count(),
            prisma.tmdbCache.findMany({
                skip,
                take: limit,
                orderBy: { updatedAt: 'desc' },
                select: { id: true, url: true, response: true, updatedAt: true }
            })
        ]);
        return { total, items, page, limit };
    }
    catch (err) {
        console.error(err);
        reply.code(500).send({ error: 'Database error' });
    }
});
const start = async () => {
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        console.log('🎥 TMDB Cache Viewer running at http://localhost:' + PORT);
    }
    catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};
start();
//# sourceMappingURL=viewer.js.map