import express from 'express';
import db from '../db_client';
import { Customer } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';

export const getCustomers = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query('SELECT * FROM customers WHERE store_id = $1 ORDER BY name', [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching customers:', error);
        res.status(500).json({ message: 'Error fetching customers' });
    }
};

export const getCustomerById = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query('SELECT * FROM customers WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error(`Error fetching customer ${req.params.id}:`, error);
        res.status(500).json({ message: 'Error fetching customer' });
    }
};

export const createCustomer = async (req: express.Request, res: express.Response) => {
    const { name, email, phone, address, notes, storeCredit } = req.body;
    const id = generateId('cust');
    const createdAt = new Date().toISOString();

    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(
            'INSERT INTO customers (id, name, email, phone, address, notes, created_at, store_credit, account_balance, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [id, name, email, phone, address, notes, createdAt, storeCredit || 0, 0, storeId]
        );
        const newCustomer = result.rows[0];
        auditService.log(req.user!, 'Customer Created', `Customer: "${newCustomer.name}"`);
        res.status(201).json(toCamelCase(newCustomer));
    } catch (error) {
        console.error('Error creating customer:', error);
        res.status(500).json({ message: 'Error creating customer' });
    }
};

export const updateCustomer = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { name, email, phone, address, notes, storeCredit, accountBalance } = req.body;

    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(
            'UPDATE customers SET name=$1, email=$2, phone=$3, address=$4, notes=$5, store_credit=$6, account_balance=$7 WHERE id=$8 AND store_id = $9 RETURNING *',
            [name, email, phone, address, notes, storeCredit, accountBalance, id, storeId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        const updatedCustomer = result.rows[0];
        auditService.log(req.user!, 'Customer Updated', `Customer: "${updatedCustomer.name}"`);
        res.status(200).json(toCamelCase(updatedCustomer));
    } catch (error) {
        console.error(`Error updating customer ${id}:`, error);
        res.status(500).json({ message: 'Error updating customer' });
    }
};

export const deleteCustomer = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        // Prevent deleting customers who have sales history in the current store (tenant-scoped)
        const salesCheck = await db.query('SELECT 1 FROM sales WHERE customer_id = $1 AND store_id = $2 LIMIT 1', [id, storeId]);
        if (salesCheck.rowCount && salesCheck.rowCount > 0) {
            return res.status(400).json({ message: 'Cannot delete customer with sales history.' });
        }

        const result = await db.query('DELETE FROM customers WHERE id = $1 AND store_id = $2 RETURNING name', [id, storeId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const deletedCustomer = result.rows[0];
        auditService.log(req.user!, 'Customer Deleted', `Customer: "${deletedCustomer.name}"`);
        res.status(200).json({ message: 'Customer deleted' });
    } catch (error) {
        console.error(`Error deleting customer ${id}:`, error);
        res.status(500).json({ message: 'Error deleting customer' });
    }
};