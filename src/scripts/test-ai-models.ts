
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from the root .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function listModels() {
    console.log("Checking API Key...");
    const apiKey = process.env.API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        console.error("❌ No API_KEY found in environment variables.");
        process.exit(1);
    }
    console.log("✅ API Key found.");

    // Using a direct fetch to the API to list models if SDK doesn't support listing easily or to verify raw access
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    console.log("\n--- Listing Available Models via API ---");
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.models) {
            console.log(`Found ${data.models.length} models:`);
            data.models.forEach((model: any) => {
                console.log(`- ${model.name} (${model.supportedGenerationMethods.join(', ')})`);
            });
        } else {
            console.log("⚠️ No models returned in list. Response:", JSON.stringify(data, null, 2));
        }
    } catch (error: any) {
        console.error("❌ Error fetching models:", error.message);
    }

    console.log("\n--- Testing Specific Model Access ---");
    const genAI = new GoogleGenerativeAI(apiKey);

    // Test base gemini-1.5-flash which should exist
    try {
        console.log("Attempting `gemini-1.5-flash` generation...");
        // Use 'gemini-1.5-flash' directly
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent("Hello");
        console.log("✅ gemini-1.5-flash works! Response:", result.response.text());
    } catch (e: any) {
        console.log("❌ gemini-1.5-flash failed:", e.message);
    }

}

listModels();
