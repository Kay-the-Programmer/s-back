
const { GoogleGenAI } = require("@google/genai");
require('dotenv').config();

async function listModels() {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        console.error("No API_KEY in .env");
        return;
    }

    const ai = new GoogleGenAI({ apiKey: apiKey });

    try {
        console.log("Fetching models...");
        // The SDK interface for listing models might differ slightly depending on version,
        // but looking at recent docs:
        // It seems the new SDK might not have a direct helper or it's on ai.models.list()
        // Let's try to infer from typical patterns or just try a basic generation to 'gemini-1.5-flash' again with full log.

        // Actually, let's try to generate with a known older model 'gemini-pro' just to see if AUTH works,
        // and if we can get a better error or success.
        // Also, usually there is a listModels method.
        // Inspecting the error stack trace from user: 
        // at Models.generateContent (node_modules\@google\genai\dist\node\index.cjs)

        // The @google/genai package is the newer one (not @google/generative-ai).
        // In @google/genai 0.0.1+, it might be different.

        // Let's just try to run a simple generation with gemini-1.5-flash-001 vs gemini-1.5-flash
        // and maybe gemini-pro.

        const modelsToTry = [
            'gemini-1.5-flash',
            'gemini-1.5-flash-001',
            'gemini-1.5-flash-002',
            'gemini-1.5-pro',
            'gemini-1.0-pro'
        ];

        for (const model of modelsToTry) {
            console.log(`\nTesting model: ${model}`);
            try {
                const response = await ai.models.generateContent({
                    model: model,
                    contents: "Hello, are you there?",
                });
                console.log(`✅ Success with ${model}`);
            } catch (e) {
                console.log(`❌ Failed with ${model}: ${e.message}`);
            }
        }

    } catch (error) {
        console.error("Error:", error);
    }
}

listModels();
