import express from 'express';
import { getUsers, createUser, updateUser, deleteUser, getUserById, setCurrentStore } from '../controllers/users.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

// All routes in this file are admin-only
router.use(protect, adminOnly);

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: Get all users in the store (admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 *   post:
 *     tags: [Users]
 *     summary: Create a new user (admin only)
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
 *               email: { type: string }
 *               password: { type: string }
 *               role: { type: string, enum: [admin, staff, inventory_manager] }
 *     responses:
 *       201:
 *         description: User created
 */
router.route('/')
    .get(getUsers)
    .post(createUser);

/**
 * @openapi
 * /users/me/current-store:
 *   patch:
 *     tags: [Users]
 *     summary: Set the current active store for the authenticated user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               storeId: { type: string }
 */
router.patch('/me/current-store', setCurrentStore);

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Get a user by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   put:
 *     tags: [Users]
 *     summary: Update a user
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Users]
 *     summary: Delete a user
 *     security:
 *       - bearerAuth: []
 */
router.route('/:id')
    .get(getUserById)
    .put(updateUser)
    .delete(deleteUser);

export default router;