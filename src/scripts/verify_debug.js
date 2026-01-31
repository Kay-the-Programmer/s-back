
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function verify() {
    console.log("ENV Keys:", Object.keys(process.env).filter(k => k.includes('KEY') || k.includes('API')));
    const apiKey = process.env.API_KEY;
    console.log("Using API_KEY:", apiKey ? `${apiKey.substring(0, 4)}...` : "MISSING");

    if (!apiKey) {
        return;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        console.log("Testing Chat...");
        const textModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        const textResult = await textModel.generateContent("Hello");
        console.log("Chat Success:", textResult.response.text());
    } catch (e) {
        console.error("Verification Error:", e.message);
    }
}
verify();
