
import { GoogleGenAI } from "@google/genai";
import dotenv from 'dotenv';
dotenv.config();

async function listModels() {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        console.error("No API_KEY in .env");
        return;
    }

    // Debug: print start
    console.log("Starting model check with API Key ending in...", apiKey.slice(-4));

    const ai = new GoogleGenAI({ apiKey: apiKey });

    const modelsToTry = [
        'gemini-1.5-flash',
        'gemini-1.5-flash-001',
        'gemini-1.5-flash-latest',
        'gemini-pro',
        'gemini-1.0-pro'
    ];

    for (const model of modelsToTry) {
        process.stdout.write(`Testing model: ${model} ... `);
        try {
            const response = await ai.models.generateContent({
                model: model,
                contents: "Hello",
            });
            console.log(`✅ Success`);
        } catch (e: any) {
            console.log(`❌ Failed: ${e.message}`);
        }
    }
}

listModels().catch(console.error);
