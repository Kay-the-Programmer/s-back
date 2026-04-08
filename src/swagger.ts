import swaggerJsdoc from 'swagger-jsdoc';
import path from 'path';

// Use require to avoid TypeScript rootDir violation (package.json is outside src/)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version } = require('../package.json') as { version: string };

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SalePilot API Documentation',
      version,
      description: 'API documentation for the SalePilot POS system.',
      contact: {
        name: 'SalePilot Support',
        url: 'https://salepilot.space',
      },
    },
    servers: [
      {
        url: '/api',
        description: 'Main API',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  // Use absolute paths to ensure it works in both source (dev) and compiled (prod/Docker) modes
  apis: [
    path.join(__dirname, 'api', '*.routes.{ts,js}'),
    path.join(__dirname, 'api', 'schemas.swagger.{ts,js}'),
  ],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
