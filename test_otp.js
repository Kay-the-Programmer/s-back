const http = require('http');

async function run() {
    try {
        console.log("Registering test user...");
        const uid = Math.random().toString(36).substring(7);
        const registerReq = await fetch('http://localhost:5000/api/auth/register-customer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Test User', email: `testotp${uid}@test.com`, password: 'password123', phone: '12345678' })
        });
        const registerRes = await registerReq.json();
        const token = registerRes.token;

        if (!token) {
            console.error("Failed to register user:", registerRes);
            return;
        }

        console.log("User registered. Creating store...");
        const storeReq = await fetch('http://localhost:5000/api/stores/register', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ name: `OTP Test Store ${uid}`, businessTypes: ['retail'], phone: '12345678' })
        });
        const storeRes = await storeReq.json();

        console.log("Store registration response:", storeRes);
        const storeId = storeRes.store ? storeRes.store.id : null;
        if (!storeId) {
            console.error("No store id returned");
            return;
        }
        console.log(`Store ID: ${storeId}`);

        console.log("Waiting a moment to check db for OTP...");
        await new Promise(r => setTimeout(r, 2000));

        console.log("Attempting to verify with a wrong OTP...");
        const failVerifyReq = await fetch('http://localhost:5000/api/stores/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ storeId, otp: '111111' })
        });

        if (!failVerifyReq.ok) {
            const textResponse = await failVerifyReq.text();
            console.log("Failed Verify HTTP Response:", failVerifyReq.status, textResponse);
        } else {
            console.log("Wrong OTP verify response:", await failVerifyReq.json());
        }

    } catch (err) {
        console.error("Test error:", err);
    }
}

run();
