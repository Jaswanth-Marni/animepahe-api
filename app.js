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
    const protocol = req.protocol;
    const host = req.headers.host;
    Config.setHostUrl(protocol, host);
    next();
});

// Apply rate limiting only if RATE_LIMIT_SECRET is set (only affects your deployment)
app.use(rateLimiter);

app.use('/api', testRoutes);
app.use('/api', homeRoutes); // caching done in homeRoutes
app.use('/api', cache(30), queueRoutes); // 30 seconds
app.use('/api', cache(18000), animeListRoutes); // 1 hour
app.use('/api', cache(86400), animeInfoRoutes); // 1 day
app.use('/api', cache(3600), playRoutes);  // 5 hours

// =============================================
// M3U8 Stream Proxy - Bypasses CDN Referer check
// =============================================
app.get('/api/proxy/m3u8', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                'Referer': 'https://kwik.cx/',
                'Origin': 'https://kwik.cx',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            responseType: 'arraybuffer',
            timeout: 15000
        });

        const contentType = response.headers['content-type'] || 'application/octet-stream';
        res.set('Content-Type', contentType);
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Headers', '*');

        // If it's an m3u8 playlist, rewrite internal URLs to also go through the proxy
        if (contentType.includes('mpegurl') || targetUrl.endsWith('.m3u8')) {
            let body = response.data.toString('utf-8');
            const hostUrl = `https://${req.headers.host}`;

            // 1. Extract the AES key URI if it exists
            let keyUri = '';
            const keyMatch = body.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"/);
            if (keyMatch) {
                // Rewrite the key URI to use our proxy
                keyUri = `${hostUrl}/api/proxy/m3u8?url=${encodeURIComponent(keyMatch[1])}`;
            }

            let newBody = '';
            const lines = body.split('\n');
            
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                
                let rewrittenLine = line;
                // Rewrite absolute URLs to use our proxy
                if (line.startsWith('http://') || line.startsWith('https://')) {
                    rewrittenLine = `${hostUrl}/api/proxy/m3u8?url=${encodeURIComponent(line)}`;
                }

                // FIX FOR KWIK HLS FRAGMENT DROPS:
                // Kwik drops segments but doesn't update the Media Sequence or insert Discontinuities.
                // This breaks hls.js AES-128 decryption because the IV goes out of sync!
                // We fix this by explicitly defining the IV for EVERY segment based on its filename number.
                if (line.includes('segment-') && line.endsWith('.jpg')) {
                    const segMatch = line.match(/segment-(\d+)/);
                    if (segMatch && keyUri) {
                        const segNum = parseInt(segMatch[1], 10);
                        const ivHex = segNum.toString(16).padStart(32, '0');
                        newBody += `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}",IV=0x${ivHex}\n`;
                    }
                }

                // Skip the global EXT-X-KEY since we inject it before every segment now
                if (line.startsWith('#EXT-X-KEY') && keyUri) {
                    continue;
                }

                newBody += rewrittenLine + '\n';
            }

            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.send(newBody);
        } else {
            res.send(Buffer.from(response.data));
        }
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(502).json({ error: 'Failed to proxy stream', message: error.message });
    }
});

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
