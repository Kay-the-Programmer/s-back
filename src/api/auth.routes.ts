import express from 'express';
import { loginUser, registerUser, registerCustomer, registerSupplier, getCurrentUser, forgotPassword, changePassword, googleLogin } from '../controllers/auth.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/login', loginUser);
router.post('/google', googleLogin);
router.post('/register', registerUser);
router.post('/register-customer', registerCustomer);
router.post('/register-supplier', registerSupplier);
router.post('/forgot-password', forgotPassword);
router.get('/me', protect, getCurrentUser);
router.post('/change-password', protect, changePassword);

export default router;