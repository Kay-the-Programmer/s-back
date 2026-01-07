import express from 'express';
import { getShopInfo, getShopProducts, getShopProductById, getShopCategories, createShopOrder, getPublicStores } from '../controllers/shop.controller';

const router = express.Router();

// Public shop routes - No authentication required
router.get('/stores', getPublicStores);
router.get('/:storeId/info', getShopInfo);
router.get('/:storeId/categories', getShopCategories);
router.get('/:storeId/products', getShopProducts);
router.get('/:storeId/products/:productId', getShopProductById);
router.post('/:storeId/orders', createShopOrder);

export default router;
