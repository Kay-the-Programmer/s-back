import db from '../db_client';

export const LogisticsService = {
    // --- Couriers ---
    async createCourier(storeId: string, data: { company_name: string; contact_details?: string; receipt_details?: string }) {
        const id = `courier_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const query = `
      INSERT INTO couriers (id, company_name, contact_details, receipt_details, store_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
        const result = await db.query(query, [id, data.company_name, data.contact_details, data.receipt_details, storeId]);
        return result.rows[0];
    },

    async getCouriers(storeId: string) {
        const query = `SELECT * FROM couriers WHERE store_id = $1 AND is_active = TRUE ORDER BY created_at DESC`;
        const result = await db.query(query, [storeId]);
        return result.rows;
    },

    async updateCourier(storeId: string, id: string, data: Partial<{ company_name: string; contact_details: string; receipt_details: string }>) {
        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;

        if (data.company_name !== undefined) {
            fields.push(`company_name = $${idx++}`);
            values.push(data.company_name);
        }
        if (data.contact_details !== undefined) {
            fields.push(`contact_details = $${idx++}`);
            values.push(data.contact_details);
        }
        if (data.receipt_details !== undefined) {
            fields.push(`receipt_details = $${idx++}`);
            values.push(data.receipt_details);
        }

        if (fields.length === 0) return null;

        values.push(id);
        values.push(storeId); // Security check to ensure ownership

        const query = `
      UPDATE couriers
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${idx++} AND store_id = $${idx++}
      RETURNING *
    `;
        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deleteCourier(storeId: string, id: string) {
        // Soft delete
        const query = `UPDATE couriers SET is_active = FALSE WHERE id = $1 AND store_id = $2 RETURNING id`;
        const result = await db.query(query, [id, storeId]);
        return result.rows[0];
    },

    // --- Buses ---
    async createBus(storeId: string, data: { driver_name: string; vehicle_name?: string; number_plate: string; contact_phone?: string }) {
        const id = `bus_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const query = `
      INSERT INTO buses (id, driver_name, vehicle_name, number_plate, contact_phone, store_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
        const result = await db.query(query, [id, data.driver_name, data.vehicle_name, data.number_plate, data.contact_phone, storeId]);
        return result.rows[0];
    },

    async getBuses(storeId: string) {
        const query = `SELECT * FROM buses WHERE store_id = $1 AND is_active = TRUE ORDER BY created_at DESC`;
        const result = await db.query(query, [storeId]);
        return result.rows;
    },

    async updateBus(storeId: string, id: string, data: Partial<{ driver_name: string; vehicle_name: string; number_plate: string; contact_phone: string }>) {
        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;

        if (data.driver_name !== undefined) {
            fields.push(`driver_name = $${idx++}`);
            values.push(data.driver_name);
        }
        if (data.vehicle_name !== undefined) {
            fields.push(`vehicle_name = $${idx++}`);
            values.push(data.vehicle_name);
        }
        if (data.number_plate !== undefined) {
            fields.push(`number_plate = $${idx++}`);
            values.push(data.number_plate);
        }
        if (data.contact_phone !== undefined) {
            fields.push(`contact_phone = $${idx++}`);
            values.push(data.contact_phone);
        }

        if (fields.length === 0) return null;

        values.push(id);
        values.push(storeId);

        const query = `
      UPDATE buses
      SET ${fields.join(', ')}, updated_at = NOW()
      WHERE id = $${idx++} AND store_id = $${idx++}
      RETURNING *
    `;
        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deleteBus(storeId: string, id: string) {
        const query = `UPDATE buses SET is_active = FALSE WHERE id = $1 AND store_id = $2 RETURNING id`;
        const result = await db.query(query, [id, storeId]);
        return result.rows[0];
    },

    // --- Shipments ---
    async createShipment(storeId: string, data: {
        tracking_number: string;
        method: 'courier' | 'bus';
        courier_id?: string;
        bus_id?: string;
        sale_id?: string;
        recipient_name?: string;
        recipient_phone?: string;
        recipient_address?: string;
        destination?: string;
        shipping_cost?: number;
        image_urls?: string[];
        notes?: string;
    }) {
        const id = `ship_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        // If tracking number not provided, generate one? User prompt says "issue tracking number".
        // Assuming backend generates or user provides. Let's assume passed in or fallback.
        const trackingNo = data.tracking_number || `TRK-${Date.now().toString().slice(-6)}`;

        const query = `
      INSERT INTO shipments (
        id, tracking_number, method, courier_id, bus_id, sale_id, 
        recipient_name, recipient_phone, recipient_address, destination, 
        shipping_cost, image_urls, notes, store_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *
    `;
        const result = await db.query(query, [
            id, trackingNo, data.method, data.courier_id, data.bus_id, data.sale_id,
            data.recipient_name, data.recipient_phone, data.recipient_address, data.destination,
            data.shipping_cost || 0, data.image_urls, data.notes, storeId
        ]);
        return result.rows[0];
    },

    async getShipments(storeId: string) {
        const query = `
      SELECT s.*, 
             c.company_name as courier_name, 
             b.driver_name as bus_driver_name, 
             b.number_plate as bus_number_plate
      FROM shipments s
      LEFT JOIN couriers c ON s.courier_id = c.id
      LEFT JOIN buses b ON s.bus_id = b.id
      WHERE s.store_id = $1 
      ORDER BY s.created_at DESC
    `;
        const result = await db.query(query, [storeId]);
        return result.rows;
    },

    async getShipmentById(storeId: string, id: string) {
        const query = `
      SELECT s.*, 
             c.company_name as courier_name, 
             b.driver_name as bus_driver_name, 
             b.number_plate as bus_number_plate
      FROM shipments s
      LEFT JOIN couriers c ON s.courier_id = c.id
      LEFT JOIN buses b ON s.bus_id = b.id
      WHERE s.id = $1 AND s.store_id = $2
    `;
        const result = await db.query(query, [id, storeId]);
        return result.rows[0];
    },

    async updateShipmentStatus(storeId: string, id: string, status: string) {
        const query = `UPDATE shipments SET status = $1, updated_at = NOW() WHERE id = $2 AND store_id = $3 RETURNING *`;
        const result = await db.query(query, [status, id, storeId]);
        return result.rows[0];
    },

    async deleteShipment(storeId: string, id: string) {
        const query = `DELETE FROM shipments WHERE id = $1 AND store_id = $2 RETURNING id`;
        const result = await db.query(query, [id, storeId]);
        return result.rows[0];
    },

    /**
     * Public lookup by tracking number (no store scope, no auth). Returns only
     * the fields that are safe to show a recipient tracking their delivery.
     */
    async trackByNumber(trackingNumber: string) {
        const query = `
      SELECT s.tracking_number, s.status, s.method, s.destination, s.recipient_name,
             s.created_at, s.updated_at,
             c.company_name as courier_name,
             b.driver_name as bus_driver_name, b.number_plate as bus_number_plate,
             ss.name as store_name
      FROM shipments s
      LEFT JOIN couriers c ON s.courier_id = c.id
      LEFT JOIN buses b ON s.bus_id = b.id
      LEFT JOIN store_settings ss ON ss.store_id = s.store_id
      WHERE LOWER(s.tracking_number) = LOWER($1)
      ORDER BY s.created_at DESC
      LIMIT 1
    `;
        const result = await db.query(query, [trackingNumber.trim()]);
        return result.rows[0];
    }
};
