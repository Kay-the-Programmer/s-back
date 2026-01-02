import express from 'express';

export const errorMiddleware: express.ErrorRequestHandler = (err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(err.stack);

  return res.status(500).json({
    message: 'An unexpected server error occurred.',
    error: process.env.NODE_ENV === 'development' ? err.message : {},
  });
};