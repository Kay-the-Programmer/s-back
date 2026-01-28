import axios from 'axios';

const BASE_URL = 'http://localhost:5000/api';
// You'll need a valid token and storeId for this to work
const TOKEN = 'YOUR_TOKEN_HERE';
const STORE_ID = 'YOUR_STORE_ID_HERE';

async function testSubscriptionCancel() {
    try {
        console.log('1. Initiating a subscription payment...');
        const initiateRes = await axios.post(`${BASE_URL}/subscriptions/pay`, {
            storeId: STORE_ID,
            planId: 'plan_pro',
            method: 'mobile-money',
            phoneNumber: '0970000000'
        }, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        const { reference } = initiateRes.data;
        console.log(`   Initiated with reference: ${reference}`);

        console.log('2. Attempting to cancel the transaction...');
        const cancelRes = await axios.post(`${BASE_URL}/subscriptions/cancel/${reference}`, {}, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        console.log('   Cancel Response:', cancelRes.data);
        if (cancelRes.data.success) {
            console.log('✅ PASS: Subscription cancellation successful.');
        } else {
            console.log('❌ FAIL: Subscription cancellation returned false success.');
        }

    } catch (error: any) {
        console.error('❌ ERROR:', error.response?.data || error.message);
    }
}

// testSubscriptionCancel();
