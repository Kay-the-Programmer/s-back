import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './api';
import { errorMiddleware } from './middleware/error.middleware';
import './types/request';
import './init_db'; // Initialize database tables
import path from 'path';
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// --- Middleware ---
// Configure CORS with specific options suitable for Vercel/Render
const allowedOrigins: (string | RegExp)[] = [
  process.env.FRONTEND_URL || '',
  /https?:\/\/.+\.vercel\.app$/,
  /https?:\/\/.+\.onrender\.com$/,
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean) as (string | RegExp)[];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow non-browser tools
    const isAllowed = allowedOrigins.some((o) =>
      typeof o === 'string' ? origin === o : (o as RegExp).test(origin)
    );
    if (isAllowed) return callback(null, true);
    return callback(new Error(`CORS: Origin ${origin} not allowed`), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- API Routes ---
app.use('/api', apiRoutes);

// --- Basic Route ---
app.get('/', (req: express.Request, res: express.Response) => {
  res.send('SalePilot Backend is running!');
});


// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// --- Error Handling ---
app.use(errorMiddleware);

app.listen(port, () => {
  console.log(`[server]: Server is running at http://localhost:${port}`);
});