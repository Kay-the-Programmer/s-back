import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import apiRoutes from './api';
import { errorMiddleware } from './middleware/error.middleware';
import './types/request';
import initializeDatabase from './init_db';
import seedDatabase from './seed';
import path from 'path';
import SocketService from './services/socket.service';
import './firebase';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger';

const app = express();
const port = process.env.PORT || 5000;

// --- Middleware ---
// Configure CORS with specific options suitable for Vercel/Render
const allowedOrigins: (string | RegExp)[] = [
  process.env.FRONTEND_URL || '',
  'https://salepilot-scope.vercel.app',
  /https?:\/\/.+\.vercel\.app$/,
  /https?:\/\/.+\.onrender\.com$/,
  'https://www.salepilot.space',
  'https://salepilot.space',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
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
  allowedHeaders: ['Content-Type', 'Authorization', 'x-firebase-appcheck'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/api', apiRoutes);

// --- Swagger Documentation ---
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

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

const startServer = async () => {
  try {
    await initializeDatabase();
    await seedDatabase();

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

    // Use httpServer.listen instead of app.listen
    httpServer.listen(port, () => {
      console.log(`[server]: Server is running at http://localhost:${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();