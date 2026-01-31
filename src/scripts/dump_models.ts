
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function listModels() {
    const apiKey = process.env.API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        console.error("No API_KEY found.");
        return;
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.models) {
            const modelNames = data.models.map((m: any) => m.name);
            fs.writeFileSync('available_models.txt', modelNames.join('\n'));
            console.log("Models dumped to available_models.txt");
        } else {
            console.log("No models found.");
        }
    } catch (error) {
        console.error("Error:", error);
    }
}
listModels();
