import express from 'express';
import { getUsers, createUser, updateUser, deleteUser, getUserById, setCurrentStore } from '../controllers/users.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

// All routes in this file are admin-only
router.use(protect, adminOnly);

router.route('/')
    .get(getUsers)
    .post(createUser);

router.patch('/me/current-store', setCurrentStore);

router.route('/:id')
    .get(getUserById)
    .put(updateUser)
    .delete(deleteUser);

export default router;