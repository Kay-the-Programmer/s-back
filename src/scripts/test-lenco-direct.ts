import LencoService from '../services/lenco.service';
import * as dotenv from 'dotenv';
import path from 'path';

// Load .env from backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const runTest = async () => {
    // Test cases for normalization and detection
    const testCases = [
        { phone: '0977433571', amount: 10, note: 'Normal format' },
        { phone: '+260961111111', amount: 5, note: 'International format' },
        { phone: '761111111', amount: 2, note: 'No prefix' }
    ];

    for (const test of testCases) {
        console.log(`\n--- Testing: ${test.note} (${test.phone}) ---`);
        try {
            const reference = LencoService.generateReference('TEST_REF');
            // We pass null for operator to test auto-detection
            const result = await LencoService.chargeMobileMoney(test.amount, reference, test.phone);
            console.log('Success:', JSON.stringify(result, null, 2));
        } catch (error: any) {
            console.error('Failed:', error.message || error);
        }
    }
};

runTest();
