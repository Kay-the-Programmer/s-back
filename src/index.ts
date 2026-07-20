import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { Server } from 'socket.io';
import apiRoutes from './api';
import { errorMiddleware } from './middleware/error.middleware';
import { idempotency } from './middleware/idempotency.middleware';
import './types/request';
import initializeDatabase from './init_db';
import seedDatabase from './seed';
import path from 'path';
import SocketService from './services/socket.service';
import './firebase';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger';
import db from './db_client';

const app = express();
const port = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Behind Caddy (prod) / any reverse proxy: trust the first X-Forwarded-For hop
// so req.ip is the real client — required for per-IP rate limiting to work
// (otherwise every request appears to come from the proxy container).
app.set('trust proxy', 1);

// --- Security headers & response compression ---
app.use(helmet({
  // This server is a JSON API; CSP is for HTML documents and would only
  // interfere with the (non-production) Swagger UI.
  contentSecurityPolicy: false,
  // /uploads images are embedded by the frontend on a DIFFERENT origin
  // (Vercel/salepilot.space) — the default same-origin policy would block them.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(compression());

// --- Middleware ---
// Configure CORS. In production only the real app origins are allowed; the
// broad dev conveniences (any localhost port, any *.vercel.app preview) are
// enabled outside production or explicitly via CORS_ALLOW_DEV_ORIGINS=true.
const devOrigins: (string | RegExp)[] = [
  /https?:\/\/.+\.vercel\.app$/,
  /https?:\/\/.+\.onrender\.com$/,
  // Any localhost port — local dev servers (vite picks 5173/5180/5191/…)
  /^https?:\/\/localhost(:\d+)?$/,
  'http://localhost',
  'https://localhost',
];
const allowedOrigins: (string | RegExp)[] = [
  process.env.FRONTEND_URL || '',
  'https://salepilot-scope.vercel.app',
  'https://www.salepilot.space',
  'https://salepilot.space',
  ...((!isProduction || process.env.CORS_ALLOW_DEV_ORIGINS === 'true') ? devOrigins : []),
].filter(Boolean) as (string | RegExp)[];


const normalizeOrigin = (o: string) => o.replace(/\/+$/, '').toLowerCase().trim();

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const normalizedOrigin = normalizeOrigin(origin);
    const isAllowed = allowedOrigins.some((o) => {
      if (typeof o === 'string') {
        return normalizedOrigin === normalizeOrigin(o);
      }
      return (o as RegExp).test(origin);
    });

    if (isAllowed) {
      return callback(null, true);
    } else {
      console.error(`❌ CORS Blocked Origin: "${origin}" (Normalized: "${normalizedOrigin}")`);
      return callback(new Error(`CORS: Origin ${origin} not allowed`), false);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // 'x-idempotency-key' is sent by the web client on every mutation (and on
  // offline-queue replays) so the server can dedupe retried writes. It MUST be
  // allowed here or the CORS preflight fails and every cross-origin mutation
  // (including POST /auth/google sign-in) is blocked by the browser.
  allowedHeaders: ['Content-Type', 'Authorization', 'x-firebase-appcheck', 'x-idempotency-key'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight
// Capture the raw request body so webhook handlers can verify signatures
// (e.g. WhatsApp's X-Hub-Signature-256 must be computed over the exact bytes).
// 5mb is ample for JSON payloads — image uploads go through multer (multipart),
// not this parser, and an oversized limit is a memory-DoS lever.
app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => { (req as any).rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// --- Rate limiting ---
// Strict limiter on credential endpoints (login brute-force protection).
// Successful logins don't count toward the limit, so a shared shop IP where
// several staff sign in each morning isn't throttled.
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts. Please try again in a few minutes.' },
});
// verify-* and resend-verification are included so a 6-digit OTP can't be
// brute-forced: skipSuccessfulRequests means only wrong guesses count, capping
// attempts at 30 per 10 min per IP.
for (const p of ['/api/auth/login', '/api/auth/register', '/api/auth/register-customer', '/api/auth/register-supplier', '/api/auth/google', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/verify-registration', '/api/auth/verify-email', '/api/auth/resend-verification']) {
  app.use(p, authLimiter);
}
// Generous global limiter — a ceiling against runaway clients/scrapers, far
// above what the app generates (30s notification polling ≈ 10 req/5min/tab).
app.use('/api', rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 1500,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
}));

// Dedupe retried writes (offline-queue replays) by X-Idempotency-Key before
// they reach the route handlers. No-op for requests without the header.
app.use('/api', idempotency);

app.use('/api', apiRoutes);

// --- Swagger Documentation ---
// Never expose the full API map on the public internet: available in
// non-production, or in production only when ENABLE_API_DOCS=true is set.
if (!isProduction || process.env.ENABLE_API_DOCS === 'true') {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
}

// --- Basic Route ---
app.get('/', (req: express.Request, res: express.Response) => {
  res.send('SalePilot Backend is running!');
});


// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/images', express.static(path.join(__dirname, '../public/images')));

// --- Error Handling ---
app.use(errorMiddleware);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // Allow all for now, or use corsOptions if needed
    methods: ['GET', 'POST']
  }
});
// Initialize socket service
new SocketService(io);

import { runRecurringExpenses } from './controllers/recurring-expenses.controller';
import { notificationSchedulerService } from './services/notification-scheduler.service';
import { runSubscriptionLifecycle } from './services/subscription-lifecycle.service';
import { runAddonRenewals } from './services/module-purchase.service';
import { runStaleOrderCleanup } from './services/stale-order.service';
import { runPlanRenewals } from './services/subscription.service';
import { ensureCatalogSeeded } from './services/catalog.service';
import { ensureEmailTemplatesSeeded } from './services/email-template.service';
import { ensureUpsellCampaignsTable } from './services/upsell-campaign.service';
import { ensureUpsellEventsTable } from './services/upsell-analytics.service';

const startServer = async () => {
  try {
    await initializeDatabase();
    await seedDatabase();

    // Seed the configurable commerce catalog (add-on modules + plans) if empty.
    await ensureCatalogSeeded().catch(err => console.error('[catalog] seed failed:', err));

    // Seed the configurable email templates (superadmin-editable) if missing.
    await ensureEmailTemplatesSeeded().catch(err => console.error('[email-templates] seed failed:', err));

    // Ensure the upsell-campaigns table exists (marketing console persistence).
    await ensureUpsellCampaignsTable().catch(err => console.error('[upsell-campaigns] table init failed:', err));
    await ensureUpsellEventsTable().catch(err => console.error('[upsell-events] table init failed:', err));

    // Process recurring expenses on startup
    runRecurringExpenses().then(count => {
      if (count > 0) console.log(`[recurring] Processed ${count} expenses on startup`);
    }).catch(err => console.error('[recurring] Error on startup processing:', err));

    // Run every hour
    setInterval(() => {
      runRecurringExpenses().then(count => {
        if (count > 0) console.log(`[recurring] Processed ${count} expenses`);
      }).catch(err => console.error('[recurring] Error in interval processing:', err));
    }, 60 * 60 * 1000);

    // Run periodic notifications every 24 hours
    notificationSchedulerService.sendPeriodicTips().catch((err: unknown) => console.error('[scheduler] Error in startup tips processing:', err));
    setInterval(() => {
      notificationSchedulerService.sendPeriodicTips().catch((err: unknown) => console.error('[scheduler] Error in periodic tips processing:', err));
    }, 24 * 60 * 60 * 1000);

    // Expire lapsed trials / unpaid renewals every 6 hours (downgrades to past_due
    // and revokes premium add-ons; core POS stays free). This is what makes the
    // freemium model actually enforce — without it, trials never end.
    runSubscriptionLifecycle().catch(err => console.error('[lifecycle] Error on startup run:', err));
    setInterval(() => {
      runSubscriptionLifecycle().catch(err => console.error('[lifecycle] Error in interval run:', err));
    }, 6 * 60 * 60 * 1000);

    // Auto-renew / dunning for à-la-carte add-ons AND subscription plans (initiate
    // near expiry, confirm pending charges, remind manual renewers). Every 12 hours.
    const runRenewals = () => {
      runAddonRenewals().catch(err => console.error('[renewal] add-on error:', err));
      runPlanRenewals().catch(err => console.error('[plan-renewal] error:', err));
    };
    runRenewals();
    setInterval(runRenewals, 12 * 60 * 60 * 1000);

    // Auto-cancel stale unpaid online orders (pay-on-delivery no-shows) so
    // they release the stock they reserved at checkout. Every 6 hours.
    runStaleOrderCleanup().catch(err => console.error('[stale-orders] Error on startup run:', err));
    setInterval(() => {
      runStaleOrderCleanup().catch(err => console.error('[stale-orders] Error in interval run:', err));
    }, 6 * 60 * 60 * 1000);

    // WhatsApp marketing automation: send due scheduled/recurring campaigns and
    // evaluate triggers (win-back, welcome, post-purchase) every 5 minutes.
    const { runDueCampaigns } = await import('./services/whatsapp-campaign.service');
    runDueCampaigns().catch(err => console.error('[wa-campaign] startup run error:', err));
    setInterval(() => {
      runDueCampaigns().catch(err => console.error('[wa-campaign] interval error:', err));
    }, 5 * 60 * 1000);

    // Use httpServer.listen instead of app.listen
    httpServer.listen(port, () => {
      console.log(`[server]: Server is running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown: stop accepting connections, let in-flight requests finish,
// then close DB connections — so `docker stop` / deploys don't sever requests
// mid-flight (Docker sends SIGTERM, then SIGKILL after the grace period).
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — draining connections…`);
  httpServer.close(() => {
    db._pool.end()
      .catch((err: unknown) => console.error('[server] pool close error:', err))
      .finally(() => {
        console.log('[server] shutdown complete');
        process.exit(0);
      });
  });
  // Hard exit if draining takes longer than Docker's default 10s grace period.
  setTimeout(() => { console.error('[server] drain timeout — forcing exit'); process.exit(1); }, 9000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();