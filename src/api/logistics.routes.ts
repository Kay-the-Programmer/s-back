import express from 'express';
import { protect } from '../middleware/auth.middleware';
import {
    createCourier,
    getCouriers,
    updateCourier,
    deleteCourier,
    createBus,
    getBuses,
    updateBus,
    deleteBus,
    createShipment,
    getShipments,
    getShipmentById,
    updateShipmentStatus,
    deleteShipment
} from '../controllers/logistics.controller';

const router = express.Router();

router.use(protect);

// Couriers
router.post('/couriers', createCourier);
router.get('/couriers', getCouriers);
router.put('/couriers/:id', updateCourier);
router.delete('/couriers/:id', deleteCourier);

// Buses
// Note: Buses are separate entities as requested, but could be unified in UI if needed.
router.post('/buses', createBus);
router.get('/buses', getBuses);
router.put('/buses/:id', updateBus);
router.delete('/buses/:id', deleteBus);

// Shipments
router.post('/shipments', createShipment);
router.get('/shipments', getShipments);
router.get('/shipments/:id', getShipmentById);
router.patch('/shipments/:id/status', updateShipmentStatus);
router.delete('/shipments/:id', deleteShipment);

export default router;
