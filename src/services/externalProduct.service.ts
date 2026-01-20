import axios from 'axios';

interface ExternalProductData {
    name: string;
    description: string;
    imageUrls: string[];
    brand: string;
    barcode: string;
    weight?: number;
    unitOfMeasure?: 'kg' | 'unit';
}

class ExternalProductService {
    private readonly API_URL = 'https://world.openfoodfacts.org/api/v2/product';

    async lookupByBarcode(barcode: string): Promise<ExternalProductData | null> {
        try {
            const response = await axios.get(`${this.API_URL}/${barcode}`, {
                headers: {
                    'User-Agent': 'SalePilot/1.0 (internal-dev-testing)'
                }
            });

            if (response.data && response.data.status === 1 && response.data.product) {
                const p = response.data.product;

                // Map OpenFoodFacts data to our structure
                const name = p.product_name || p.product_name_en || '';
                const brand = p.brands || '';
                const description = p.generic_name || p.generic_name_en || '';

                // Images
                const imageUrls: string[] = [];
                if (p.image_url) imageUrls.push(p.image_url);
                if (p.image_front_url && !imageUrls.includes(p.image_front_url)) imageUrls.push(p.image_front_url);

                // Weight parsing (very basic)
                let weight: number | undefined;
                let unitOfMeasure: 'kg' | 'unit' = 'unit';

                if (p.quantity) {
                    // Try to extract weight if possible, e.g. "500g", "1kg"
                    const quantityStr = String(p.quantity).toLowerCase();
                    if (quantityStr.includes('kg')) {
                        const match = quantityStr.match(/([\d.]+)\s*kg/);
                        if (match) {
                            weight = parseFloat(match[1]);
                            unitOfMeasure = 'kg';
                        }
                    } else if (quantityStr.includes('g')) {
                        const match = quantityStr.match(/([\d.]+)\s*g/);
                        if (match) {
                            weight = parseFloat(match[1]) / 1000;
                            unitOfMeasure = 'kg'; // We store weight in kg largely
                        }
                    }
                }

                return {
                    name,
                    description,
                    imageUrls,
                    brand,
                    barcode,
                    weight,
                    unitOfMeasure
                };
            }
            return null;
        } catch (error) {
            console.error('Error fetching from external API:', error);
            // Don't crash, just return null so we can fall back to "not found"
            return null;
        }
    }
}

export const externalProductService = new ExternalProductService();
