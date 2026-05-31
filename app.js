const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Config = require('./utils/config');
const { errorHandler, CustomError } = require('./middleware/errorHandler');
const rateLimiter = require('./middleware/rateLimiter');
const homeRoutes = require('./routes/homeRoutes');
const queueRoutes = require('./routes/queueRoutes');
const animeListRoutes = require('./routes/animeListRoutes');
const animeInfoRoutes = require('./routes/animeInfoRoutes');
const playRoutes = require('./routes/playRoutes');
const testRoutes = require('./routes/testRoutes');
const cache = require('./middleware/cache');

const app = express();

// Load environment variables into Config
try {
    Config.validate();
    Config.loadFromEnv();
    console.log('\x1b[36m%s\x1b[0m', 'Configuration set!.'); // Just wanted to try adding colors
} catch (error) {
    console.error(error.message);
    process.exit(1); 
}

// CORS Configuration
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        
        const allowedOrigins = process.env.ALLOWED_ORIGINS 
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : ['*']; // Default: allow all origins
        
        if (allowedOrigins.includes('*')) {
            return callback(null, true);
        }
        
        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

app.use(cors(corsOptions));

// Middleware to set hostUrl ONCE based on first incoming request
app.use((req, res, next) => {
    // Force HTTPS for the proxy URLs (since Render handles SSL termination)
    const hostUrl = `https://${req.headers.host}`;
    Config.setHostUrl('https', req.headers.host);
    next();
});

// Apply rate limiting
app.use(rateLimiter);

// ---> PROXY ROUTE WITH DISCONTINUITY AND IV FIX <---
app.get('/api/proxy/m3u8', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).send('URL required');

        const response = await axios.get(targetUrl, {
            headers: {
                'Referer': 'https://kwik.cx/',
                'Origin': 'https://kwik.cx',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            responseType: 'arraybuffer',
            timeout: 15000
        });

        if (targetUrl.includes('.key')) {
            res.set({
                'Content-Type': 'application/octet-stream',
                'Access-Control-Allow-Origin': '*'
            });
            return res.send(response.data);
        } else if (targetUrl.includes('.jpg')) {
            res.set({
                'Content-Type': 'video/mp2t',
                'Access-Control-Allow-Origin': '*'
            });
            return res.send(response.data);
        } else if (targetUrl.includes('.m3u8')) {
            let m3u8Content = Buffer.from(response.data).toString('utf-8');
            const lines = m3u8Content.split('\n');
            const modifiedLines = [];
            
            // Extract the base URL to construct absolute URLs for the key and segments
            const baseUrlMatch = targetUrl.match(/(https?:\/\/[^\/]+\/stream\/[^\/]+\/[^\/]+\/[^\/]+\/)/);
            const baseUrl = baseUrlMatch ? baseUrlMatch[1] : '';

            let lastSegmentIndex = 0; // Track segment numbers to detect jumps
            const hostUrl = Config.getHostUrl();

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (!line) continue;

                if (line.startsWith('#EXT-X-KEY')) {
                    // Skip existing keys, we inject them manually before EXTINF
                    continue;
                } else if (line.startsWith('#EXTINF:')) {
                    // Look ahead for the segment file
                    let segmentFile = '';
                    for (let j = i + 1; j < lines.length; j++) {
                        let peek = lines[j].trim();
                        if (peek && !peek.startsWith('#')) {
                            segmentFile = peek;
                            break;
                        }
                    }

                    if (segmentFile) {
                        const match = segmentFile.match(/segment-(\d+)-/);
                        if (match) {
                            const currentSegmentIndex = parseInt(match[1], 10);
                            
                            // CRITICAL FIX: If segments are skipped (e.g. 1 -> 4), inject a discontinuity
                            if (lastSegmentIndex !== 0 && currentSegmentIndex > lastSegmentIndex + 1) {
                                modifiedLines.push('#EXT-X-DISCONTINUITY');
                            }
                            lastSegmentIndex = currentSegmentIndex;

                            // Inject the decryption key perfectly paired to this segment
                            let hexIv = currentSegmentIndex.toString(16).padStart(32, '0');
                            const keyUrl = `${baseUrl}mon.key`;
                            const proxyKeyUrl = `${hostUrl}/api/proxy/m3u8?url=${encodeURIComponent(keyUrl)}`;
                            modifiedLines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${proxyKeyUrl}",IV=0x${hexIv}`);
                        }
                    }
                    modifiedLines.push(line);
                } else if (!line.startsWith('#')) {
                    // It's a segment URL
                    const segUrl = baseUrl + line;
                    modifiedLines.push(`${hostUrl}/api/proxy/m3u8?url=${encodeURIComponent(segUrl)}`);
                } else {
                    modifiedLines.push(line);
                }
            }

            res.set({
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Access-Control-Allow-Origin': '*'
            });
            res.send(modifiedLines.join('\n'));
        }
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(502).json({ error: 'Failed to proxy stream', message: error.message });
    }
});

app.use('/api', testRoutes);
app.use('/api', homeRoutes); // caching done in homeRoutes
app.use('/api', cache(30), queueRoutes); // 30 seconds
app.use('/api', cache(18000), animeListRoutes); // 1 hour
app.use('/api', cache(86400), animeInfoRoutes); // 1 day
app.use('/api', cache(3600), playRoutes);  // 5 hours

app.use((req, res, next) => {
    if (!req.route) {
        next(new CustomError('Route not found. Please check the API documentation at https://github.com/ElijahCodes12345/animepahe-api', 404));
    } else {
        next();
    }
});

// Error handling middleware
app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
});
