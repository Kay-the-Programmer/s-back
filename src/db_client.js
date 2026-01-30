"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var pg_1 = require("pg");
var dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
var isProduction = process.env.NODE_ENV === 'production' || process.env.DB_SSL === 'true';
var pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});
exports.default = {
    query: function (text, params) { return pool.query(text, params); },
    // Expose the pool for scripts like seeding to manage connection lifecycle
    _pool: pool,
};
