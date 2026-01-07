import { createShopOrder } from '../controllers/shop.controller';
import db from '../db_client';
import fs from 'fs';
import path from 'path';

const logFile = path.join(__dirname, 'verify_output.txt');
const log = (msg: string) => {
    console.log(msg);
    fs.appendFileSync(logFile, msg + '\n');
};

const runTest = async () => {
    // Clear log file
    fs.writeFileSync(logFile, '');

    // 1. Get a valid store and product
    log('Fetching test data...');
    const storeRes = await db.query('SELECT id FROM stores LIMIT 1');
    const storeId = storeRes.rows[0]?.id;

    if (!storeId) {
        log('No stores found, cannot test.');
        process.exit(0);
    }

    const prodRes = await db.query('SELECT id FROM products WHERE store_id = $1 LIMIT 1', [storeId]);
    const productId = prodRes.rows[0]?.id;

    if (!productId) {
        log('No products found, cannot test.');
        process.exit(0);
    }

    log(`Testing with Store: ${storeId}, Product: ${productId}`);

    // Mock Req/Res
    const mockRes = () => {
        const res: any = {};
        res.status = (code: number) => {
            res.statusCode = code;
            return res;
        };
        res.json = (data: any) => {
            log(`Response [${res.statusCode}]: ${JSON.stringify(data)}`);
            return res; // chainable
        };
        res.send = (data: any) => {
            log(`Response [${res.statusCode}]: ${data}`);
            return res;
        };
        return res;
    };

    // Test 1: Invalid Quantity
    log('\nTest 1: Invalid Quantity (NaN)');
    try {
        await createShopOrder({
            params: { storeId },
            body: {
                customerDetails: { name: 'Test User', email: 'test@example.com' },
                cart: [{ id: productId, quantity: 'invalid' }]
            }
        } as any, mockRes());
    } catch (e) {
        log('Test 1 crashed: ' + e);
    }

    // Test 2: Negative Quantity
    log('\nTest 2: Negative Quantity');
    try {
        await createShopOrder({
            params: { storeId },
            body: {
                customerDetails: { name: 'Test User', email: 'test@example.com' },
                cart: [{ id: productId, quantity: -5 }]
            }
        } as any, mockRes());
    } catch (e) {
        log('Test 2 crashed: ' + e);
    }

    // Test 3: Missing Product ID
    log('\nTest 3: Missing Product ID');
    try {
        await createShopOrder({
            params: { storeId },
            body: {
                customerDetails: { name: 'Test User', email: 'test@example.com' },
                cart: [{ quantity: 10 }]
            }
        } as any, mockRes());
    } catch (e) {
        log('Test 3 crashed: ' + e);
    }

    process.exit(0);
};

runTest();
