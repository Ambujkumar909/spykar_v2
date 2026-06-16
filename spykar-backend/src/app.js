const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const { errorHandler } = require('./middleware/errorHandler');
const { notFound } = require('./middleware/notFound');
const logger = require('./config/logger');

// Route imports
const { authRouter, userRouter } = require('./routes/auth.routes');
const inventoryRoutes = require('./routes/inventory.routes');
const distributorRoutes = require('./routes/distributor.routes');
const locationRoutes = require('./routes/location.routes');
const skuRoutes = require('./routes/sku.routes');
const dispatchRoutes = require('./routes/dispatch.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const aiRoutes = require('./routes/ai.routes');
const syncRoutes = require('./routes/sync.routes');
const filterRoutes = require('./routes/filters.routes');
const stockAvailabilityRoutes = require('./routes/stockAvailability.routes');

const app = express();

// ─── Request timeout ──────────────────────────────────────────────────────────
// Bound every HTTP request at 45s so a pathological query can never leave a
// browser tab hanging forever. This is an HTTP-socket timeout — it does NOT
// set a Postgres statement_timeout, so the long-running ETL sync (COPY merges
// that legitimately run for minutes) is completely unaffected. After the
// analytics rollup work lands, no legitimate API request comes close to 45s.
app.use((req, res, next) => {
  res.setTimeout(45000, () => {
    if (!res.headersSent) {
      res.status(503).json({ success: false, message: 'Request timed out. Please narrow your filters and retry.' });
    }
  });
  next();
});

// ─── Security & Performance Middleware ────────────────────────────────────────
app.use(helmet());
app.use(compression());
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // In development, allow any localhost port
    if (process.env.NODE_ENV !== 'production' && /^http:\/\/localhost(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/api/v1/auth'),
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, please try again in a few minutes.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200,
  message: { success: false, message: 'AI query limit reached. Please wait a moment.' },
  skipSuccessfulRequests: false,
});

app.use(globalLimiter);

// ─── Body Parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Request Logging ───────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (message) => logger.http(message.trim()) },
}));

// ─── Health Check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  });
});

app.get('/health/deep', async (req, res) => {
  const { checkDatabase } = require('./config/database');
  const { checkCache } = require('./config/cache');

  const [dbStatus, cacheStatus] = await Promise.allSettled([
    checkDatabase(),
    checkCache(),
  ]);

  const status = {
    success: true,
    database: dbStatus.status === 'fulfilled' ? 'connected' : 'error',
    cache: cacheStatus.status === 'fulfilled' ? 'in-memory' : 'error',
    timestamp: new Date().toISOString(),
  };

  // Cache is in-process and always available; DB is the only hard dependency.
  const httpStatus = status.database === 'connected' ? 200 : 503;
  res.status(httpStatus).json(status);
});

// ─── API Routes ────────────────────────────────────────────────────────────────
const API_V1 = '/api/v1';

app.use(`${API_V1}/auth`, authLimiter, authRouter);
app.use(`${API_V1}/users`, userRouter);
app.use(`${API_V1}/inventory`, inventoryRoutes);
app.use(`${API_V1}/distributors`, distributorRoutes);
app.use(`${API_V1}/locations`, locationRoutes);
app.use(`${API_V1}/skus`, skuRoutes);
app.use(`${API_V1}/dispatch`, dispatchRoutes);
app.use(`${API_V1}/analytics`, analyticsRoutes);
app.use(`${API_V1}/ai`, aiLimiter, aiRoutes);
app.use(`${API_V1}/sync`, syncRoutes);
app.use(`${API_V1}/filters`, filterRoutes);
app.use(`${API_V1}/stock-availability`, stockAvailabilityRoutes);

// ─── Error Handling ────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

module.exports = app;
