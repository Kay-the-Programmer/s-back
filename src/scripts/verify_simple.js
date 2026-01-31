
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function verify() {
    console.log("Starting verification...");
    const apiKey = process.env.API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        console.error("API Key missing");
        return;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey);

        console.log("Testing Chat...");
        const textModel = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
        const textResult = await textModel.generateContent("Hello");
        console.log("Chat Success:", textResult.response.text());

        console.log("Testing Image...");
        const imgModel = genAI.getGenerativeModel({ model: "imagen-4.0-generate-001" });
        const imgResult = await imgModel.generateContent({
            contents: [{ role: "user", parts: [{ text: "Small blue dot" }] }],
            generationConfig: {
                aspect_ratio: "1:1",
                number_of_images: 1
            }
        });
        const imgResponse = await imgResult.response;
        console.log("Image Success (Candidate count):", imgResponse.candidates.length);
    } catch (e) {
        console.error("Verification Error:", e.message);
    }
}

verify().then(() => console.log("Done."));
