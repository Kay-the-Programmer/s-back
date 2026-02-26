import { Request, Response } from 'express';
import db from '../db_client';
import { LogisticsService } from '../services/logistics.service';

// Helper to get storeId
const getStoreId = (req: Request) => req.tenant?.storeId || req.user?.currentStoreId;

export const createCourier = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { company_name, contact_details, receipt_details } = req.body;
        if (!company_name) return res.status(400).json({ message: 'Company name is required' });

        const courier = await LogisticsService.createCourier(storeId, { company_name, contact_details, receipt_details });
        res.status(201).json(courier);
    } catch (error: any) {
        console.error('Create courier error:', error);
        res.status(500).json({ message: 'Failed to create courier', error: error.message });
    }
};

export const getCouriers = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const couriers = await LogisticsService.getCouriers(storeId);
        res.json(couriers);
    } catch (error: any) {
        console.error('Get couriers error:', error);
        res.status(500).json({ message: 'Failed to fetch couriers' });
    }
};

export const updateCourier = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;
        const data = req.body;

        const updated = await LogisticsService.updateCourier(storeId, id, data);
        if (!updated) return res.status(404).json({ message: 'Courier not found or no changes provided' });
        res.json(updated);
    } catch (error: any) {
        console.error('Update courier error:', error);
        res.status(500).json({ message: 'Failed to update courier' });
    }
};

export const deleteCourier = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;

        const deleted = await LogisticsService.deleteCourier(storeId, id);
        if (!deleted || !deleted.id) return res.status(404).json({ message: 'Courier not found' });
        res.json({ message: 'Courier deleted successfully' });
    } catch (error: any) {
        console.error('Delete courier error:', error);
        res.status(500).json({ message: 'Failed to delete courier' });
    }
};

export const createBus = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { driver_name, vehicle_name, number_plate, contact_phone } = req.body;
        if (!driver_name || !number_plate) return res.status(400).json({ message: 'Driver name and Number plate are required' });

        const bus = await LogisticsService.createBus(storeId, { driver_name, vehicle_name, number_plate, contact_phone });
        res.status(201).json(bus);
    } catch (error: any) {
        console.error('Create bus error:', error);
        res.status(500).json({ message: 'Failed to create bus', error: error.message });
    }
};

export const getBuses = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const buses = await LogisticsService.getBuses(storeId);
        res.json(buses);
    } catch (error: any) {
        console.error('Get buses error:', error);
        res.status(500).json({ message: 'Failed to fetch buses' });
    }
};

export const updateBus = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;
        const data = req.body;

        const updated = await LogisticsService.updateBus(storeId, id, data);
        if (!updated) return res.status(404).json({ message: 'Bus not found or no changes provided' });
        res.json(updated);
    } catch (error: any) {
        console.error('Update bus error:', error);
        res.status(500).json({ message: 'Failed to update bus' });
    }
};

export const deleteBus = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;

        const deleted = await LogisticsService.deleteBus(storeId, id);
        if (!deleted || !deleted.id) return res.status(404).json({ message: 'Bus not found' });
        res.json({ message: 'Bus deleted successfully' });
    } catch (error: any) {
        console.error('Delete bus error:', error);
        res.status(500).json({ message: 'Failed to delete bus' });
    }
};

export const createShipment = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        // Pass everything to service, validate key fields
        const data = req.body;
        if (!data.method) return res.status(400).json({ message: 'Shipping method is required (courier/bus)' });
        if (data.method === 'courier' && !data.courier_id) return res.status(400).json({ message: 'Courier ID is required for courier method' });
        if (data.method === 'bus' && !data.bus_id) return res.status(400).json({ message: 'Bus ID is required for bus method' });

        const shipment = await LogisticsService.createShipment(storeId, data);
        res.status(201).json(shipment);
    } catch (error: any) {
        console.error('Create shipment error:', error);
        res.status(500).json({ message: 'Failed to create shipment', error: error.message });
    }
};

export const getShipments = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const shipments = await LogisticsService.getShipments(storeId);
        res.json(shipments);
    } catch (error: any) {
        console.error('Get shipments error:', error);
        res.status(500).json({ message: 'Failed to fetch shipments' });
    }
};

export const getShipmentById = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;

        const shipment = await LogisticsService.getShipmentById(storeId, id);
        if (!shipment) return res.status(404).json({ message: 'Shipment not found' });
        res.json(shipment);
    } catch (error: any) {
        console.error('Get shipment error:', error);
        res.status(500).json({ message: 'Failed to fetch shipment' });
    }
};

export const updateShipmentStatus = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;
        const { status } = req.body;
        if (!status) return res.status(400).json({ message: 'Status is required' });

        const updated = await LogisticsService.updateShipmentStatus(storeId, id, status);
        if (!updated) return res.status(404).json({ message: 'Shipment not found' });

        // Notify Customer if sale_id exists
        if (updated.sale_id) {
            try {
                const saleRes = await db.query('SELECT customer_id FROM sales WHERE transaction_id = $1', [updated.sale_id]);
                if (saleRes.rowCount && saleRes.rowCount > 0 && saleRes.rows[0].customer_id) {
                    const { pushService } = await import('../services/push.service');
                    let msg = `Your shipment for order ${updated.sale_id} is now ${status}.`;
                    if (status === 'shipped') msg = `Your order ${updated.sale_id} is on its way! 🚚`;
                    if (status === 'in_transit') msg = `Your order ${updated.sale_id} is currently in transit. 🗺️`;
                    if (status === 'delivered') msg = `Your order ${updated.sale_id} has been delivered! 📦`;

                    await pushService.sendToUsers([saleRes.rows[0].customer_id], {
                        title: 'Shipment Update',
                        body: msg,
                        url: '/marketplace/orders'
                    });
                }
            } catch (pushErr) {
                console.error('Shipment push failed:', pushErr);
            }
        }

        res.json(updated);
    } catch (error: any) {
        console.error('Update shipment status error:', error);
        res.status(500).json({ message: 'Failed to update shipment status' });
    }
};

export const deleteShipment = async (req: Request, res: Response) => {
    try {
        const storeId = getStoreId(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const { id } = req.params;

        const deleted = await LogisticsService.deleteShipment(storeId, id);
        if (!deleted || !deleted.id) return res.status(404).json({ message: 'Shipment not found' });
        res.json({ message: 'Shipment deleted successfully' });
    } catch (error: any) {
        console.error('Delete shipment error:', error);
        res.status(500).json({ message: 'Failed to delete shipment' });
    }
}
