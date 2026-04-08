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

/**
 * @openapi
 * /logistics/couriers:
 *   get:
 *     tags: [Logistics]
 *     summary: Get all couriers
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of couriers
 *   post:
 *     tags: [Logistics]
 *     summary: Create a new courier
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               phone: { type: string }
 *               vehicleType: { type: string }
 */
router.post('/couriers', createCourier);
router.get('/couriers', getCouriers);

/**
 * @openapi
 * /logistics/couriers/{id}:
 *   put:
 *     tags: [Logistics]
 *     summary: Update a courier
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Logistics]
 *     summary: Delete a courier
 *     security:
 *       - bearerAuth: []
 */
router.put('/couriers/:id', updateCourier);
router.delete('/couriers/:id', deleteCourier);

/**
 * @openapi
 * /logistics/buses:
 *   get:
 *     tags: [Logistics]
 *     summary: Get all buses
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of buses
 *   post:
 *     tags: [Logistics]
 *     summary: Create a new bus
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               route: { type: string }
 *               plateNumber: { type: string }
 */
router.post('/buses', createBus);
router.get('/buses', getBuses);

/**
 * @openapi
 * /logistics/buses/{id}:
 *   put:
 *     tags: [Logistics]
 *     summary: Update a bus
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Logistics]
 *     summary: Delete a bus
 *     security:
 *       - bearerAuth: []
 */
router.put('/buses/:id', updateBus);
router.delete('/buses/:id', deleteBus);

/**
 * @openapi
 * /logistics/shipments:
 *   get:
 *     tags: [Logistics]
 *     summary: Get all shipments
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of shipments
 *   post:
 *     tags: [Logistics]
 *     summary: Create a new shipment
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               saleId: { type: string }
 *               courierId: { type: string }
 *               destination: { type: string }
 */
router.post('/shipments', createShipment);
router.get('/shipments', getShipments);

/**
 * @openapi
 * /logistics/shipments/{id}:
 *   get:
 *     tags: [Logistics]
 *     summary: Get a shipment by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Logistics]
 *     summary: Delete a shipment
 *     security:
 *       - bearerAuth: []
 */
router.get('/shipments/:id', getShipmentById);
router.delete('/shipments/:id', deleteShipment);

/**
 * @openapi
 * /logistics/shipments/{id}/status:
 *   patch:
 *     tags: [Logistics]
 *     summary: Update the status of a shipment
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [pending, in_transit, delivered, failed]
 */
router.patch('/shipments/:id/status', updateShipmentStatus);

export default router;
