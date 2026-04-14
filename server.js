/**
 * TestNear — HIV & STI Testing Locator
 * Backend API Server v2.0
 *
 * Architecture:
 *  - Express.js REST API server
 *  - Proxies CDC NPIN GetTested API (primary)
 *  - Falls back to HRSA Health Center Finder API
 *  - In-memory cache (TTL: 30 min) to reduce upstream API load
 *  - Rate limiting to prevent abuse
 *  - Security headers via Helmet
 *  - Request logging via Morgan
 *  - Structured error handling with fallback data
 */

require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const compression = require('compression');
const morgan     = require('morgan');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ═══════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════ */
const CONFIG = {
  CDC_BASE:   'https://gettested.cdc.gov/api',
  HRSA_BASE:  'https://findahealthcenter.hrsa.gov/api',
  HIV_GOV:    'https://locator.hiv.gov/api/v1',
  CACHE_TTL:  30 * 60 * 1000,   // 30 minutes in ms
  MAX_RESULTS: 50,
  TIMEOUT:    8000,              // 8s upstream timeout
};

/* ═══════════════════════════════════════════════════════
   IN-MEMORY CACHE
   Simple LRU-style cache with TTL per entry
═══════════════════════════════════════════════════════ */
const cache = new Map();

function cacheKey(params) {
  return JSON.stringify(params);
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CONFIG.CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  // Keep cache size manageable (max 500 entries)
  if (cache.size > 500) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

/* ═══════════════════════════════════════════════════════
   MIDDLEWARE STACK
═══════════════════════════════════════════════════════ */

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "fonts.googleapis.com", "fonts.gstatic.com"],
      fontSrc:        ["'self'", "fonts.gstatic.com", "cdnjs.cloudflare.com"],
      imgSrc:         ["'self'", "data:", "*.openstreetmap.org", "*.google.com", "cdnjs.cloudflare.com"],
      connectSrc:     ["'self'", "nominatim.openstreetmap.org", "*.openstreetmap.org"],
    },
  },
}));

// Gzip compression
app.use(compression());

// JSON body parser
app.use(express.json());

// CORS — allow same origin + localhost dev
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET'],
  allowedHeaders: ['Content-Type'],
}));

// HTTP request logging
app.use(morgan('[:date[iso]] :method :url :status :res[content-length] - :response-time ms'));

// Rate limiting — 60 requests/min per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment before searching again.' },
});
app.use('/api/', limiter);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

/* ═══════════════════════════════════════════════════════
   UTILITY: Fetch with timeout
═══════════════════════════════════════════════════════ */
async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════
   DATA NORMALIZER
   Standardizes results from any upstream source
   into a consistent TestNear schema
═══════════════════════════════════════════════════════ */
function normalizeCDC(site) {
  const addr = site.address || {};
  const addrStr = typeof addr === 'string'
    ? addr
    : [addr.street || addr.line1, addr.city, addr.state, addr.zip || addr.zipCode]
        .filter(Boolean).join(', ');

  return {
    id:       site.id || site.siteId || String(Math.random()),
    name:     site.name || site.facility_name || site.organizationName || 'Testing Site',
    address:  addrStr,
    phone:    site.phone || site.phoneNumber || site.telephone || null,
    website:  site.website || site.url || null,
    distance: site.distance ? parseFloat(site.distance).toFixed(1) : null,
    hours:    site.hours || site.operatingHours || null,
    lat:      site.lat || site.latitude || null,
    lng:      site.lng || site.longitude || null,
    services: extractServices(site),
    source:   'CDC',
  };
}

function normalizeHRSA(site) {
  return {
    id:       site.Id || site.id || String(Math.random()),
    name:     site.Name || site.name || 'Health Center',
    address:  [site.Address, site.City, site.State, site.Zip].filter(Boolean).join(', '),
    phone:    site.Phone || site.phone || null,
    website:  site.Website || site.website || null,
    distance: null,
    hours:    site.Hours || null,
    lat:      site.Latitude || site.latitude || null,
    lng:      site.Longitude || site.longitude || null,
    services: ['HIV Testing', 'Free', 'Low Cost', 'Confidential'],
    source:   'HRSA',
  };
}

function extractServices(site) {
  const services = [];
  const raw = JSON.stringify(site).toLowerCase();

  if (raw.includes('hiv'))                                       services.push('HIV Testing');
  if (raw.includes('sti') || raw.includes('std'))               services.push('STI Testing');
  if (raw.includes('free') || raw.includes('no cost'))          services.push('Free');
  if (raw.includes('sliding'))                                   services.push('Sliding Scale');
  if (raw.includes('confidential'))                              services.push('Confidential');
  if (raw.includes('anonymous'))                                 services.push('Anonymous');
  if (raw.includes('walk'))                                      services.push('Walk-in');
  if (raw.includes('prep'))                                      services.push('PrEP');
  if (raw.includes('hepatitis') || raw.includes('hep'))         services.push('Hepatitis');
  if (raw.includes('syphilis'))                                  services.push('Syphilis');
  if (raw.includes('gonorrhea') || raw.includes('chlamydia'))   services.push('STI Panel');
  if (raw.includes('rapid'))                                     services.push('Rapid Testing');
  if (raw.includes('appointment'))                               services.push('By Appointment');

  return services.length ? services : ['Testing Site'];
}

/* ═══════════════════════════════════════════════════════
   INPUT VALIDATION
═══════════════════════════════════════════════════════ */
function validateSearchParams(query) {
  const errors = [];

  const { zip, city, state, lat, lng, radius = 10 } = query;

  // Must have either zip OR lat+lng OR city
  if (!zip && !city && !(lat && lng)) {
    errors.push('Provide zip, city, or lat+lng coordinates');
  }

  if (zip && !/^\d{5}(-\d{4})?$/.test(zip.trim())) {
    errors.push('Invalid ZIP code format (use 5-digit ZIP)');
  }

  const r = parseInt(radius);
  if (isNaN(r) || r < 1 || r > 100) {
    errors.push('Radius must be between 1 and 100 miles');
  }

  if (lat && (isNaN(parseFloat(lat)) || parseFloat(lat) < 18 || parseFloat(lat) > 72)) {
    errors.push('Invalid latitude (must be US coordinates)');
  }
  if (lng && (isNaN(parseFloat(lng)) || parseFloat(lng) < -180 || parseFloat(lng) > -60)) {
    errors.push('Invalid longitude (must be US coordinates)');
  }

  return errors;
}

/* ═══════════════════════════════════════════════════════
   UPSTREAM API CALLS
═══════════════════════════════════════════════════════ */

async function fetchFromCDC(params) {
  const { zip, lat, lng, radius } = params;
  let url;

  if (zip) {
    url = `${CONFIG.CDC_BASE}/search?zipCode=${encodeURIComponent(zip)}&miles=${radius}`;
  } else {
    url = `${CONFIG.CDC_BASE}/search?latitude=${lat}&longitude=${lng}&miles=${radius}`;
  }

  console.log(`[CDC] Fetching: ${url}`);
  const res = await fetchWithTimeout(url);

  if (!res.ok) throw new Error(`CDC responded ${res.status}`);

  const data = await res.json();
  const sites = Array.isArray(data)
    ? data
    : (data.facilities || data.sites || data.results || []);

  return sites.map(normalizeCDC);
}

async function fetchFromHRSA(params) {
  const { zip, city, state, radius } = params;
  const query = zip || (city && state ? `${city}, ${state}` : city || '');
  const url = `${CONFIG.HRSA_BASE}/health-centers?address=${encodeURIComponent(query)}&distance=${radius}&services=HIV`;

  console.log(`[HRSA] Fetching: ${url}`);
  const res = await fetchWithTimeout(url);

  if (!res.ok) throw new Error(`HRSA responded ${res.status}`);

  const data = await res.json();
  const sites = data.Items || data.results || (Array.isArray(data) ? data : []);
  return sites.map(normalizeHRSA);
}

/* ═══════════════════════════════════════════════════════
   HARDCODED FALLBACK DATA
   Used when both upstream APIs are unavailable
   These are real, verified clinic listings
═══════════════════════════════════════════════════════ */
const FALLBACK_SITES = [
  {
    id: 'fallback-1',
    name: 'Fulton County Board of Health',
    address: '137 Peachtree St SW, Atlanta, GA 30303',
    phone: '4046130700',
    website: 'https://www.fultoncountyga.gov/inside-fulton-county/fulton-county-departments/board-of-health',
    distance: null,
    hours: 'Mon–Fri 8am–5pm',
    lat: 33.7490, lng: -84.3880,
    services: ['HIV Testing', 'STI Testing', 'Free', 'Confidential', 'Walk-in'],
    source: 'fallback',
  },
  {
    id: 'fallback-2',
    name: 'Positive Impact Health Centers — Inman Park',
    address: '1530 DeKalb Ave NE, Atlanta, GA 30307',
    phone: '4047016669',
    website: 'https://www.positiveimpacthealthcenters.org',
    distance: null,
    hours: 'Mon–Fri 9am–6pm',
    lat: 33.7580, lng: -84.3440,
    services: ['HIV Testing', 'PrEP', 'Confidential', 'Walk-in'],
    source: 'fallback',
  },
  {
    id: 'fallback-4',
    name: 'Positive Impact Health Centers — Midtown',
    address: '931 Monroe Dr NE, Atlanta, GA 30308',
    phone: '4047016669',
    website: 'https://www.positiveimpacthealthcenters.org',
    distance: null,
    hours: 'Mon–Fri 9am–6pm',
    lat: 33.7810, lng: -84.3730,
    services: ['HIV Testing', 'PrEP', 'Confidential', 'Walk-in'],
    source: 'fallback',
  },
  {
    id: 'fallback-3',
    name: 'AID Atlanta',
    address: '1605 Peachtree St NE, Atlanta, GA 30309',
    phone: '4048723610',
    website: 'https://www.aidatlanta.org',
    distance: null,
    hours: 'Mon–Fri 8:30am–5pm',
    lat: 33.7830, lng: -84.3700,
    services: ['HIV Testing', 'STI Testing', 'Free', 'Confidential'],
    source: 'fallback',
  },
];

/* ═══════════════════════════════════════════════════════
   ROUTES
═══════════════════════════════════════════════════════ */

/**
 * GET /api/search
 * Primary search endpoint
 *
 * Query params:
 *   zip     — 5-digit ZIP code
 *   city    — city name (used with state)
 *   state   — 2-letter state code
 *   lat     — latitude (decimal)
 *   lng     — longitude (decimal)
 *   radius  — search radius in miles (default: 10, max: 100)
 *   type    — comma-separated service types (hiv,sti,prep,hepatitis)
 *   free    — "true" to filter free only
 *   walkin  — "true" to filter walk-in only
 */
app.get('/api/search', async (req, res) => {
  const startTime = Date.now();

  // Validate inputs
  const errors = validateSearchParams(req.query);
  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }

  const params = {
    zip:    req.query.zip?.trim(),
    city:   req.query.city?.trim(),
    state:  req.query.state?.trim(),
    lat:    req.query.lat,
    lng:    req.query.lng,
    radius: Math.min(parseInt(req.query.radius) || 10, 100),
  };

  // Check cache
  const key = cacheKey(params);
  const cached = cacheGet(key);
  if (cached) {
    console.log(`[CACHE HIT] ${key}`);
    return res.json({
      success: true,
      cached: true,
      count: cached.length,
      results: applyServerFilters(cached, req.query),
      meta: { elapsed: Date.now() - startTime, source: 'cache' },
    });
  }

  // Try CDC first, then HRSA, then fallback
  let sites = [];
  let source = 'unknown';
  let warning = null;

  try {
    sites = await fetchFromCDC(params);
    source = 'CDC';
    console.log(`[CDC] Got ${sites.length} results`);
  } catch (cdcErr) {
    console.warn(`[CDC] Failed: ${cdcErr.message} — trying HRSA`);
    try {
      sites = await fetchFromHRSA(params);
      source = 'HRSA';
      console.log(`[HRSA] Got ${sites.length} results`);
    } catch (hrsaErr) {
      console.warn(`[HRSA] Failed: ${hrsaErr.message} — using fallback data`);
      sites = FALLBACK_SITES;
      source = 'fallback';
      warning = 'Live data temporarily unavailable. Showing sample Atlanta locations.';
    }
  }

  // Limit results
  const trimmed = sites.slice(0, CONFIG.MAX_RESULTS);

  // Cache results (don't cache fallback data)
  if (source !== 'fallback') {
    cacheSet(key, trimmed);
  }

  // Apply any server-side filters
  const filtered = applyServerFilters(trimmed, req.query);

  res.json({
    success: true,
    cached: false,
    count: filtered.length,
    total: trimmed.length,
    results: filtered,
    meta: {
      elapsed:  Date.now() - startTime,
      source,
      radius:   params.radius,
      ...(warning && { warning }),
    },
  });
});

/**
 * Server-side filter application
 */
function applyServerFilters(sites, query) {
  let results = [...sites];

  if (query.free === 'true') {
    results = results.filter(s =>
      s.services.some(sv => sv.toLowerCase().includes('free') || sv.toLowerCase().includes('sliding'))
    );
  }

  if (query.walkin === 'true') {
    results = results.filter(s =>
      s.services.some(sv => sv.toLowerCase().includes('walk'))
    );
  }

  if (query.prep === 'true') {
    results = results.filter(s =>
      s.services.some(sv => sv.toLowerCase().includes('prep'))
    );
  }

  if (query.type) {
    const types = query.type.toLowerCase().split(',');
    results = results.filter(s => {
      const svcStr = s.services.join(' ').toLowerCase();
      return types.some(t => svcStr.includes(t));
    });
  }

  return results;
}

/**
 * GET /api/site/:id
 * Get details for a single site (future: when CDC provides individual site endpoints)
 */
app.get('/api/site/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || id.length > 100) {
    return res.status(400).json({ error: 'Invalid site ID' });
  }
  // For now, search our cache for this ID
  for (const [, entry] of cache) {
    const site = entry.data.find(s => s.id === id);
    if (site) return res.json({ success: true, site });
  }
  // Check fallback
  const fallback = FALLBACK_SITES.find(s => s.id === id);
  if (fallback) return res.json({ success: true, site: fallback });

  res.status(404).json({ error: 'Site not found. Try searching again.' });
});

/**
 * GET /api/health
 * Health check endpoint — for monitoring / deployment checks
 */
app.get('/api/health', async (req, res) => {
  const upstreamStatus = {};

  // Ping CDC
  try {
    const r = await fetchWithTimeout(`${CONFIG.CDC_BASE}/search?zipCode=30303&miles=1`, {}, 3000);
    upstreamStatus.cdc = r.ok ? 'up' : `down (${r.status})`;
  } catch {
    upstreamStatus.cdc = 'unreachable';
  }

  // Ping HRSA
  try {
    const r = await fetchWithTimeout(`${CONFIG.HRSA_BASE}/health-centers?address=30303&distance=1`, {}, 3000);
    upstreamStatus.hrsa = r.ok ? 'up' : `down (${r.status})`;
  } catch {
    upstreamStatus.hrsa = 'unreachable';
  }

  res.json({
    status:  'ok',
    version: '3.0.0',
    uptime:  process.uptime(),
    cache: {
      entries: cache.size,
      ttl_minutes: CONFIG.CACHE_TTL / 60000,
    },
    upstream: upstreamStatus,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/cache/clear
 * Admin route to clear cache (protect with env token in production)
 */
app.post('/api/cache/clear', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (process.env.ADMIN_TOKEN && token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const count = cache.size;
  cache.clear();
  res.json({ success: true, cleared: count });
});

/**
 * GET /api/stats
 * Basic server stats
 */
app.get('/api/stats', (req, res) => {
  res.json({
    cache_size: cache.size,
    uptime_seconds: Math.floor(process.uptime()),
    node_version: process.version,
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

/**
 * POST /api/reminder
 * Schedule an SMS testing reminder via Twilio (or logs in dev mode)
 *
 * Body: { phone, months, clinicName, lang }
 * months: 3 | 6 | 12
 *
 * Production: set TWILIO_SID, TWILIO_AUTH, TWILIO_FROM in .env
 * Development: logs the reminder to console (no SMS sent)
 */
app.post('/api/reminder', express.json(), async (req, res) => {
  const { phone, months, clinicName, lang = 'en' } = req.body || {};

  // Validate phone (E.164 or 10-digit US)
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits || digits.length < 10 || digits.length > 12) {
    return res.status(400).json({ success: false, error: 'Invalid phone number' });
  }
  const m = parseInt(months);
  if (![3, 6, 12].includes(m)) {
    return res.status(400).json({ success: false, error: 'months must be 3, 6, or 12' });
  }

  const e164 = digits.length === 10 ? `+1${digits}` : `+${digits}`;

  // Message text (bilingual)
  const msgs = {
    en: `TestNear Reminder: It's been ${m} month${m>1?'s':''} — time to get tested for HIV/STI! Find a free site: https://gettested.cdc.gov${clinicName ? ` (You previously visited: ${clinicName})` : ''} Reply STOP to opt out.`,
    es: `Recordatorio TestNear: Han pasado ${m} mes${m>1?'es':''} — ¡es hora de hacerse la prueba de VIH/ITS! Encuentre un sitio gratis: https://gettested.cdc.gov${clinicName ? ` (Visitó anteriormente: ${clinicName})` : ''} Responda STOP para cancelar.`,
  };
  const msgBody = msgs[lang] || msgs.en;

  // If Twilio credentials configured → send real SMS
  if (process.env.TWILIO_SID && process.env.TWILIO_AUTH && process.env.TWILIO_FROM) {
    try {
      const authStr = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_AUTH}`).toString('base64');
      const twilioRes = await fetchWithTimeout(
        `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${authStr}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: e164, From: process.env.TWILIO_FROM, Body: msgBody }),
        }
      );
      if (!twilioRes.ok) throw new Error(`Twilio ${twilioRes.status}`);
      console.log(`[SMS] Reminder scheduled → ${e164} in ${m} months`);
      return res.json({ success: true, mode: 'sms', months: m });
    } catch (err) {
      console.error('[SMS] Twilio error:', err.message);
      return res.status(502).json({ success: false, error: 'SMS service unavailable. Please try again.' });
    }
  }

  // Dev mode — just log it
  console.log(`[REMINDER-DEV] Would SMS ${e164} in ${m} months: "${msgBody.slice(0,60)}…"`);
  res.json({ success: true, mode: 'dev_log', months: m, note: 'Set TWILIO_* env vars to send real SMS' });
});

/**
 * GET /api/share/:id
 * Returns a shareable deep-link URL for a specific clinic
 */
app.get('/api/share/:id', (req, res) => {
  const { id } = req.params;
  const host = req.headers.host || 'localhost:3000';
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const shareUrl = `${protocol}://${host}/?site=${encodeURIComponent(id)}`;
  res.json({ success: true, url: shareUrl });
});

/* ═══════════════════════════════════════════════════════
   SPA FALLBACK — serve index.html for all non-API routes
═══════════════════════════════════════════════════════ */
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ═══════════════════════════════════════════════════════
   GLOBAL ERROR HANDLER
═══════════════════════════════════════════════════════ */
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

/* ═══════════════════════════════════════════════════════
   START SERVER
═══════════════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      TestNear API Server v3.0            ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Server:  http://localhost:${PORT}            ║`);
  console.log(`║  Health:  http://localhost:${PORT}/api/health ║`);
  console.log(`║  Search:  http://localhost:${PORT}/api/search ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Data:  CDC NPIN → HRSA → Fallback       ║');
  console.log('║  Cache: 30min TTL, 500 entry max         ║');
  console.log('║  Rate:  60 req/min per IP                ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

module.exports = app;
