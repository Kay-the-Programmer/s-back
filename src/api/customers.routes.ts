import express from 'express';
import { getCustomers, createCustomer, updateCustomer, deleteCustomer, getCustomerById } from '../controllers/customers.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /customers:
 *   get:
 *     tags: [Customers]
 *     summary: Get all customers
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of customers
 *   post:
 *     tags: [Customers]
 *     summary: Create a new customer
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Customer'
 *     responses:
 *       201:
 *         description: Customer created
 */
router.route('/')
    .get(protect, getCustomers)
    .post(protect, createCustomer);

/**
 * @openapi
 * /customers/{id}:
 *   get:
 *     tags: [Customers]
 *     summary: Get customer by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   put:
 *     tags: [Customers]
 *     summary: Update a customer (admin only)
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Customers]
 *     summary: Delete a customer (admin only)
 *     security:
 *       - bearerAuth: []
 */
router.route('/:id')
    .get(protect, getCustomerById)
    .put(protect, adminOnly, updateCustomer)
    .delete(protect, adminOnly, deleteCustomer);

export default router;