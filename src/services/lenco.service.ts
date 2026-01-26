import axios from 'axios';

class LencoService {
  private baseUrl: string;
  private secretKey: string;

  constructor() {
    this.baseUrl = (process.env.LENCO_API_BASE_URL || 'https://api.lenco.co/access/v2').replace(/\/+$/, '');
    this.secretKey = process.env.LENCO_SECRET_KEY || '';

    if (!this.secretKey) {
      console.warn('⚠️ LENCO_SECRET_KEY is not set in environment variables.');
    }

    if (this.baseUrl.includes('sandbox') && this.secretKey.startsWith('sk_live')) {
      console.warn('⚠️ Environment Mismatch: Using Sandbox Base URL with a Live Secret Key!');
    } else if (!this.baseUrl.includes('sandbox') && this.secretKey.startsWith('sk_test')) {
      console.warn('⚠️ Environment Mismatch: Using Live Base URL with a Test/Sandbox Secret Key!');
    }
  }

  /**
   * Verify a transaction by its reference.
   * @param reference The unique reference generated during payment initiation.
   */
  async verifyTransaction(reference: string) {
    try {
      const url = `${this.baseUrl}/collections/status/${reference}`;
      console.log(`Lenco verifying URL: ${url}`);
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error('Lenco API Error:', error.response.data);
        // Throw the data object so the controller can handle it
        throw error.response.data;
      }
      console.error('Lenco Network Error:', error.message);
      throw new Error(error.message || 'Failed to verify transaction');
    }
  }

  /**
   * Get banks list
   * @param country country code i.e zm
   */
  async getBanks(country: string = 'zm') {
    try {
      const response = await axios.get(`${this.baseUrl}/banks?country=${country}`, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Error fetching banks:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to fetch banks');
    }
  }
}

export default new LencoService();
