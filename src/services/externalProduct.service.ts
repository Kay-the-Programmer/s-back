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
    private readonly API_URL = 'https://api.barcodelookup.com/v3/products';

    async lookupByBarcode(barcode: string): Promise<ExternalProductData | null> {
        const apiKey = process.env.BARCODE_LOOKUP_API_KEY;
        if (!apiKey) {
            console.warn('BARCODE_LOOKUP_API_KEY is not set');
            return null;
        }

        try {
            const response = await axios.get(this.API_URL, {
                params: {
                    barcode: barcode,
                    formatted: 'y',
                    key: apiKey
                }
            });

            if (response.data && response.data.products && response.data.products.length > 0) {
                const p = response.data.products[0];

                // Map Barcode Lookup data to our structure
                const name = p.title || p.product_name || '';
                const brand = p.brand || p.manufacturer || '';
                const description = p.description || '';

                // Images
                const imageUrls: string[] = [];
                if (p.images && Array.isArray(p.images)) {
                    p.images.forEach((img: string) => {
                        if (img && !imageUrls.includes(img)) imageUrls.push(img);
                    });
                }

                // Weight parsing
                // Barcode Lookup often provides 'weight' field directly e.g. "500 g"
                let weight: number | undefined;
                let unitOfMeasure: 'kg' | 'unit' = 'unit';

                // Try to parse weight from API string
                const weightStr = p.weight || '';
                if (weightStr) {
                    const wLower = weightStr.toLowerCase();
                    if (wLower.includes('kg')) {
                        const match = wLower.match(/([\d.]+)\s*kg/);
                        if (match) {
                            weight = parseFloat(match[1]);
                            unitOfMeasure = 'kg';
                        }
                    } else if (wLower.includes('g') || wLower.includes('gram')) {
                        const match = wLower.match(/([\d.]+)\s*g/);
                        if (match) {
                            weight = parseFloat(match[1]) / 1000;
                            unitOfMeasure = 'kg';
                        }
                    } else if (wLower.includes('lb') || wLower.includes('pound')) {
                        const match = wLower.match(/([\d.]+)\s*lb/);
                        if (match) {
                            weight = parseFloat(match[1]) * 0.453592; // lbs to kg
                            unitOfMeasure = 'kg';
                        }
                    } else if (wLower.includes('oz') || wLower.includes('ounce')) {
                        const match = wLower.match(/([\d.]+)\s*oz/);
                        if (match) {
                            weight = parseFloat(match[1]) * 0.0283495; // oz to kg
                            unitOfMeasure = 'kg';
                        }
                    }
                }

                return {
                    name,
                    description,
                    imageUrls,
                    brand,
                    barcode,
                    weight: weight ? parseFloat(weight.toFixed(3)) : undefined, // Round to 3 decimals
                    unitOfMeasure
                };
            }
            return null;
        } catch (error: any) {
            // Handle 404 specifically
            if (error.response && error.response.status === 404) {
                return null;
            }
            console.error('Error fetching from Barcode Lookup API:', error.message);
            return null;
        }
    }
}

export const externalProductService = new ExternalProductService();
