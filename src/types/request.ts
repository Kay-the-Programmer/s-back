
import { User } from '../types';

// Augment the Express Request type to include the user property
declare global {
  namespace Express {
    export interface Request {
      user?: User;
      tenant?: { storeId: string };
    }
  }
}

// Keep an empty export to ensure it's treated as a module.
export {};