import express from 'express';
import { getCustomers, createCustomer, updateCustomer, deleteCustomer, getCustomerById } from '../controllers/customers.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

router.route('/')
    .get(protect, getCustomers)
    .post(protect, createCustomer); 

router.route('/:id')
    .get(protect, getCustomerById)
    .put(protect, adminOnly, updateCustomer)
    .delete(protect, adminOnly, deleteCustomer);

export default router;