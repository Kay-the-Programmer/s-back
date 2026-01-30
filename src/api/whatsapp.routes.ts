
import express from 'express';
import { verifyWebhook, handleWebhook, getConfiguration, updateConfiguration, getConversations, getMessages, sendManualMessage, getSupportContact, updateSupportContact } from '../controllers/whatsapp.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Public Webhooks (Meta verification)
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleWebhook);

// Protected Routes (Admin Dashboard)
router.use(protect); // Apply auth middleware to all routes below

router.get('/config', getConfiguration);
router.put('/config', updateConfiguration);

router.get('/conversations', getConversations);
router.get('/conversations/:id/messages', getMessages);
router.post('/send', sendManualMessage);
router.get('/support-contact', getSupportContact);
router.put('/support-contact', updateSupportContact);

export default router;
