const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
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

try {
    Config.validate();
    Config.loadFromEnv();
    console.log('\x1b[36m%s\x1b[0m', 'Configuration set!.');
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
            : ['*'];
        if (allowedOrigins.includes('*')) return callback(null, true);
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

app.use((req, res, next) => {
    Config.setHostUrl('https', req.headers.host);
    next();
});

app.use(rateLimiter);

// ============ Streaming Proxy Utilities ============

const PROXY_HEADERS = {
    'Referer': 'https://kwik.cx/',
    'Origin': 'https://kwik.cx',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// AES decryption key cache (keyUrl → 16-byte Buffer)
const keyCache = new Map();

async function fetchDecryptionKey(keyUrl) {
    if (keyCache.has(keyUrl)) return keyCache.get(keyUrl);
    const resp = await axios.get(keyUrl, {
        headers: PROXY_HEADERS,
        responseType: 'arraybuffer',
        timeout: 10000
    });
    const key = Buffer.from(resp.data);
    keyCache.set(keyUrl, key);
    setTimeout(() => keyCache.delete(keyUrl), 3600000); // 1 hour TTL
    return key;
}

function decryptAes128Cbc(data, key, segmentIndex) {
    const iv = Buffer.alloc(16, 0);
    iv.writeUInt32BE(segmentIndex, 12);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

// CRC-32/MPEG-2 (ISO 13818-1) for PMT rewriting
function crc32Mpeg2(data, start, end) {
    let crc = 0xFFFFFFFF;
    for (let i = start; i < end; i++) {
        crc ^= data[i] << 24;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04C11DB7) >>> 0 : (crc << 1) >>> 0;
        }
    }
    return crc >>> 0;
}

/**
 * Strips non-essential PIDs from a decrypted MPEG-TS buffer.
 * Dynamically parses PAT → PMT, keeps only video + audio PIDs,
 * and rewrites the PMT to remove references to dropped streams.
 * This prevents hls.js from choking on unknown stream types (e.g. 0x22).
 */
function cleanTsBuffer(buf) {
    const PKT = 188;

    // Pass 1: find PMT PID from PAT
    let pmtPid = -1;
    for (let off = 0; off + PKT <= buf.length; off += PKT) {
        if (buf[off] !== 0x47) continue;
        const pid = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
        if (pid !== 0) continue;
        let p = off + 4;
        if (((buf[off + 3] >> 4) & 3) === 3) p += 1 + buf[off + 4];
        if (buf[off + 1] & 0x40) p += buf[p] + 1;
        const secLen = ((buf[p + 1] & 0x0F) << 8) | buf[p + 2];
        const entryStart = p + 8;
        const entryEnd = p + 3 + secLen - 4;
        for (let e = entryStart; e + 4 <= entryEnd; e += 4) {
            if (((buf[e] << 8) | buf[e + 1]) !== 0) {
                pmtPid = ((buf[e + 2] & 0x1F) << 8) | buf[e + 3];
                break;
            }
        }
        if (pmtPid !== -1) break;
    }
    if (pmtPid === -1) return buf;

    // Pass 2: find video & audio PIDs from PMT
    let videoPid = -1, audioPid = -1;
    for (let off = 0; off + PKT <= buf.length; off += PKT) {
        if (buf[off] !== 0x47) continue;
        const pid = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
        if (pid !== pmtPid || !(buf[off + 1] & 0x40)) continue;
        let p = off + 4;
        if (((buf[off + 3] >> 4) & 3) === 3) p += 1 + buf[off + 4];
        p += buf[p] + 1;
        const secLen = ((buf[p + 1] & 0x0F) << 8) | buf[p + 2];
        const progInfoLen = ((buf[p + 10] & 0x0F) << 8) | buf[p + 11];
        let s = p + 12 + progInfoLen;
        const sEnd = p + 3 + secLen - 4;
        while (s + 5 <= sEnd) {
            const st = buf[s];
            const ePid = ((buf[s + 1] & 0x1F) << 8) | buf[s + 2];
            const esLen = ((buf[s + 3] & 0x0F) << 8) | buf[s + 4];
            if (st === 0x1B || st === 0x24) videoPid = ePid;
            else if (st === 0x0F || st === 0x11 || st === 0x03 || st === 0x04) audioPid = ePid;
            s += 5 + esLen;
        }
        break;
    }

    const keepPids = new Set([0, pmtPid]);
    if (videoPid !== -1) keepPids.add(videoPid);
    if (audioPid !== -1) keepPids.add(audioPid);

    // Pass 3: filter packets & rewrite PMT
    const out = [];
    for (let off = 0; off + PKT <= buf.length; off += PKT) {
        if (buf[off] !== 0x47) continue;
        const pid = ((buf[off + 1] & 0x1F) << 8) | buf[off + 2];
        if (!keepPids.has(pid)) continue;
        if (pid === pmtPid && (buf[off + 1] & 0x40)) {
            const pkt = Buffer.from(buf.slice(off, off + PKT));
            rewritePmt(pkt, videoPid, audioPid);
            out.push(pkt);
        } else {
            out.push(buf.slice(off, off + PKT));
        }
    }
    return Buffer.concat(out);
}

function rewritePmt(pkt, videoPid, audioPid) {
    let p = 4;
    if (((pkt[3] >> 4) & 3) === 3) p += 1 + pkt[4];
    p += pkt[p] + 1;
    if (pkt[p] !== 0x02) return;
    const progInfoLen = ((pkt[p + 10] & 0x0F) << 8) | pkt[p + 11];
    const oldSecLen = ((pkt[p + 1] & 0x0F) << 8) | pkt[p + 2];
    const streamStart = p + 12 + progInfoLen;
    const oldEnd = p + 3 + oldSecLen - 4;
    const kept = [];
    let s = streamStart;
    while (s + 5 <= oldEnd) {
        const ePid = ((pkt[s + 1] & 0x1F) << 8) | pkt[s + 2];
        const esLen = ((pkt[s + 3] & 0x0F) << 8) | pkt[s + 4];
        if (ePid === videoPid || ePid === audioPid) {
            kept.push(Buffer.from(pkt.slice(s, s + 5 + esLen)));
        }
        s += 5 + esLen;
    }
    const newStreams = Buffer.concat(kept);
    newStreams.copy(pkt, streamStart);
    const newSecLen = 9 + progInfoLen + newStreams.length + 4;
    pkt[p + 1] = (pkt[p + 1] & 0xF0) | ((newSecLen >> 8) & 0x0F);
    pkt[p + 2] = newSecLen & 0xFF;
    const crcOff = streamStart + newStreams.length;
    for (let i = crcOff + 4; i < 188; i++) pkt[i] = 0xFF;
    pkt.writeUInt32BE(crc32Mpeg2(pkt, p, crcOff), crcOff);
}

// ============ Proxy Route ============

app.get('/api/proxy/m3u8', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).send('URL required');

        const response = await axios.get(targetUrl, {
            headers: PROXY_HEADERS,
            responseType: 'arraybuffer',
            timeout: 15000
        });

        // Use Config.hostUrl directly (NOT Config.getHostUrl())
        const hostUrl = Config.hostUrl || `https://${req.headers.host}`;
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

        if (targetUrl.endsWith('.key')) {
            res.set({ 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
            return res.send(response.data);

        } else if (/segment-\d+-/.test(targetUrl)) {
            // Encrypted TS segment → decrypt server-side, clean, serve
            const segMatch = targetUrl.match(/segment-(\d+)-/);
            const segIndex = segMatch ? parseInt(segMatch[1], 10) : 1;
            const keyUrl = baseUrl + 'mon.key';
            const key = await fetchDecryptionKey(keyUrl);
            const decrypted = decryptAes128Cbc(Buffer.from(response.data), key, segIndex);
            const clean = cleanTsBuffer(decrypted);
            res.set({ 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' });
            return res.send(clean);

        } else if (targetUrl.endsWith('.m3u8')) {
            // Playlist → rewrite: no KEY tags (we decrypt server-side), add discontinuity
            const m3u8 = Buffer.from(response.data).toString('utf-8');
            const lines = m3u8.split('\n');
            const out = [];
            let lastSeg = 0;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                if (line.startsWith('#EXT-X-KEY')) continue; // Strip key tags

                if (line.startsWith('#EXTINF:')) {
                    let segFile = '';
                    for (let j = i + 1; j < lines.length; j++) {
                        const peek = lines[j].trim();
                        if (peek && !peek.startsWith('#')) { segFile = peek; break; }
                    }
                    const m = segFile.match(/segment-(\d+)-/);
                    if (m) {
                        const cur = parseInt(m[1], 10);
                        if (lastSeg !== 0 && cur > lastSeg + 1) {
                            out.push('#EXT-X-DISCONTINUITY');
                        }
                        lastSeg = cur;
                    }
                    out.push(line);
                } else if (!line.startsWith('#')) {
                    const fullUrl = line.startsWith('http') ? line : baseUrl + line;
                    out.push(`${hostUrl}/api/proxy/m3u8?url=${encodeURIComponent(fullUrl)}`);
                } else {
                    out.push(line);
                }
            }

            res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Access-Control-Allow-Origin': '*' });
            return res.send(out.join('\n'));
        } else {
            res.set({ 'Access-Control-Allow-Origin': '*' });
            return res.send(response.data);
        }
    } catch (error) {
        console.error('Proxy error:', error.message);
        res.status(502).json({ error: 'Failed to proxy stream', message: error.message });
    }
});

// ============ Routes ============

app.use('/api', testRoutes);
app.use('/api', homeRoutes);
app.use('/api', cache(30), queueRoutes);
app.use('/api', cache(18000), animeListRoutes);
app.use('/api', cache(86400), animeInfoRoutes);
app.use('/api', cache(3600), playRoutes);

app.use((req, res, next) => {
    if (!req.route) {
        next(new CustomError('Route not found. Please check the API documentation at https://github.com/ElijahCodes12345/animepahe-api', 404));
    } else {
        next();
    }
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
});
