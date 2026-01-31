
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function verifyUpdates() {
    const apiKey = process.env.API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        console.error("❌ API Key missing.");
        return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    console.log("--- Verifying Gemini 3 Flash (Chat) ---");
    try {
        const chatModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        const chatResult = await chatModel.generateContent("Say 'Gemini 3 is active'");
        console.log("✅ Chat Response:", chatResult.response.text());
    } catch (e: any) {
        console.error("❌ Chat Failed:", e.message);
    }

    console.log("\n--- Verifying Imagen 4 (Poster) ---");
    try {
        const imageModel = genAI.getGenerativeModel({ model: "imagen-4.0-generate-001" });
        const imageResult = await imageModel.generateContent({
            contents: [{ role: 'user', parts: [{ text: "A futuristic shopping cart poster, neon lights, Zambian style" }] }],
            // @ts-ignore
            generationConfig: {
                aspectRatio: "1:1",
                sampleCount: 1
            }
        });

        const response = await imageResult.response;
        const imagePart = response.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);

        if (imagePart) {
            console.log("✅ Image Generation Success (Base64 data received)");
        } else {
            console.log("⚠️ Image Generation returned success but no image data.");
        }
    } catch (e: any) {
        console.error("❌ Image Failed:", e.message);
    }
}

verifyUpdates();
