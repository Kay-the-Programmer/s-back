import axios from 'axios';

class LencoService {
  private baseUrl: string;
  private secretKey: string;

  constructor() {
    this.baseUrl = process.env.LENCO_API_BASE_URL || 'https://api.lenco.co/access/v2';
    this.secretKey = process.env.LENCO_SECRET_KEY || '';

    if (!this.secretKey) {
      console.warn('⚠️ LENCO_SECRET_KEY is not set in environment variables.');
    }
  }

  /**
   * Verify a transaction by its reference.
   * @param reference The unique reference generated during payment initiation.
   */
  async verifyTransaction(reference: string) {
    try {
      const response = await axios.get(`${this.baseUrl}/collections/status/${reference}`, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
        },
      });

      return response.data;
    } catch (error: any) {
      console.error('Error verifying Lenco transaction:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to verify transaction');
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
