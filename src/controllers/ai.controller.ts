import { GoogleGenAI } from "@google/genai";
import express from 'express';

if (!process.env.API_KEY) {
    console.warn("API_KEY environment variable not set for Gemini. AI features will fail.");
}

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

export const generateDescription = async (req: express.Request, res: express.Response) => {
    const { productName, category } = req.body;

    if (!productName || !category) {
        return res.status(400).json({ message: 'Product name and category are required.' });
    }
    
    if (!process.env.API_KEY) {
        return res.status(500).json({ message: 'AI service is not configured on the server.' });
    }

    try {
        const prompt = `You are an expert copywriter for an e-commerce store.
          Generate a compelling, short (2-3 sentences) product description for a product with the following details:
          - Product Name: "${productName}"
          - Category: "${category}"
          
          The description should be engaging, highlight key benefits, and be suitable for a product listing. Do not include the product name or category in the description itself.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                temperature: 0.7,
                topP: 1,
                topK: 32,
                maxOutputTokens: 150,
            }
        });

        const description = (response.text ?? '').trim();
        res.status(200).json({ description });
    } catch (error) {
        console.error("Error generating description with Gemini API:", error);
        res.status(500).json({ message: 'Failed to generate AI description. Please try again.' });
    }
};