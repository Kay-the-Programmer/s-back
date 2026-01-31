
import { GoogleGenerativeAI } from "@google/generative-ai";
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables from the root .env file
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function testImagen() {
    console.log("Checking API Key...");
    const apiKey = process.env.API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        console.error("❌ No API_KEY found in environment variables.");
        process.exit(1);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "imagen-4.0-generate-001" });

    const prompt = "A futuristic car in a cyberpunk city, 8k resolution, cinematic lighting";

    console.log("Attempting `imagen-4.0-generate-001` generation with camelCase config...");

    try {
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            // @ts-ignore
            generationConfig: {
                aspectRatio: "1:1",
                numberOfImages: 1,
            }
        });

        console.log("✅ Generation Request Sent.");
        const response = await result.response;
        console.log("✅ Response received.");
        const parts = response.candidates?.[0]?.content?.parts;
        const imagePart = parts?.find((p: any) => p.inlineData);

        if (imagePart) {
            console.log("✅ Image generated successfully (inlineData present).");
        } else {
            console.log("⚠️ Response received but no inline image data found.", JSON.stringify(response, null, 2));
        }

    } catch (error: any) {
        console.error("❌ Generation failed:", error.message);
        if (error.response) {
            console.error("Error details:", JSON.stringify(error.response, null, 2));
        }
    }
}

testImagen();
