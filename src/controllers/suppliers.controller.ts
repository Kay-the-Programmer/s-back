import express from 'express';
import db from '../db_client';
import { auditService } from '../services/audit.service';
import { generateId, toCamelCase } from '../utils/helpers';

export const getSuppliers = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query('SELECT * FROM suppliers WHERE store_id = $1 ORDER BY name', [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching suppliers:', error);
        res.status(500).json({ message: 'Error fetching suppliers' });
    }
};

export const getSupplierById = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query('SELECT * FROM suppliers WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Supplier not found' });
        }
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error(`Error fetching supplier ${req.params.id}:`, error);
        res.status(500).json({ message: 'Error fetching supplier' });
    }
};

export const createSupplier = async (req: express.Request, res: express.Response) => {
    const { name, contactPerson, phone, email, address, paymentTerms, bankingDetails, notes } = req.body;
    const id = generateId('sup');
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(
            'INSERT INTO suppliers (id, name, contact_person, phone, email, address, payment_terms, banking_details, notes, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [id, name, contactPerson, phone, email, address, paymentTerms, bankingDetails, notes, storeId]
        );
        const newSupplier = result.rows[0];
        auditService.log(req.user!, 'Supplier Created', `Supplier: "${newSupplier.name}"`);
        res.status(201).json(toCamelCase(newSupplier));
    } catch (error) {
        console.error('Error creating supplier:', error);
        res.status(500).json({ message: 'Error creating supplier' });
    }
};

export const updateSupplier = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { name, contactPerson, phone, email, address, paymentTerms, bankingDetails, notes } = req.body;
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(
            'UPDATE suppliers SET name=$1, contact_person=$2, phone=$3, email=$4, address=$5, payment_terms=$6, banking_details=$7, notes=$8 WHERE id=$9 AND store_id = $10 RETURNING *',
            [name, contactPerson, phone, email, address, paymentTerms, bankingDetails, notes, id, storeId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Supplier not found' });
        }
        const updatedSupplier = result.rows[0];
        auditService.log(req.user!, 'Supplier Updated', `Supplier: "${updatedSupplier.name}"`);
        res.status(200).json(toCamelCase(updatedSupplier));
    } catch (error) {
        console.error(`Error updating supplier ${id}:`, error);
        res.status(500).json({ message: 'Error updating supplier' });
    }
};

export const deleteSupplier = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    // NOTE: This should be a transaction
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        await db.query('UPDATE products SET supplier_id = NULL WHERE supplier_id = $1 AND store_id = $2', [id, storeId]);

        const result = await db.query('DELETE FROM suppliers WHERE id = $1 AND store_id = $2 RETURNING name', [id, storeId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Supplier not found' });
        }
        const deletedSupplier = result.rows[0];
        auditService.log(req.user!, 'Supplier Deleted', `Supplier: "${deletedSupplier.name}"`);
        res.status(200).json({ message: 'Supplier deleted and products unlinked' });
    } catch (error) {
        console.error(`Error deleting supplier ${id}:`, error);
        res.status(500).json({ message: 'Error deleting supplier' });
    }
};