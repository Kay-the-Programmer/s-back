import axios from 'axios';

class LencoService {
  private _baseUrl: string | null = null;
  private _secretKey: string | null = null;
  private _loggedEnv = false;

  private get baseUrl(): string {
    if (!this._baseUrl) {
      const envUrl = process.env.LENCO_API_BASE_URL;
      const key = this.secretKey;

      if (envUrl) {
        this._baseUrl = envUrl.replace(/\/+$/, '');
      } else {
        // Auto-detect based on key
        if (key.startsWith('sk_test') || key.startsWith('851685')) { // Known sandbox prefix for this user
          this._baseUrl = 'https://sandbox.lenco.co/access/v2';
        } else {
          this._baseUrl = 'https://api.lenco.co/access/v2';
        }
      }
    }
    return this._baseUrl;
  }

  private get secretKey(): string {
    if (!this._secretKey) {
      this._secretKey = process.env.LENCO_SECRET_KEY || '';
    }
    return this._secretKey;
  }

  private logEnvOnce() {
    if (this._loggedEnv) return;
    this._loggedEnv = true;

    const key = this.secretKey;
    const maskedKey = key ? `${key.substring(0, 6)}...${key.substring(key.length - 4)}` : 'NOT SET';
    const currentBaseUrl = this.baseUrl;

    console.log(`[LencoService] Initialized with BaseURL: ${currentBaseUrl} and Masked Key: ${maskedKey}`);

    if (!key) {
      console.warn('⚠️ LENCO_SECRET_KEY is not set in environment variables.');
    }

    const isSandboxUrl = currentBaseUrl.includes('sandbox');
    const isTestKey = key.startsWith('sk_test') || key.startsWith('851685');

    if (isSandboxUrl && !isTestKey) {
      console.warn('⚠️ Environment Mismatch: Using Sandbox Base URL with what looks like a Live Secret Key!');
    } else if (!isSandboxUrl && isTestKey) {
      console.warn('⚠️ Environment Mismatch: Using Live Base URL with a Test/Sandbox Secret Key!');
    }
  }

  /**
   * Verify a transaction by its reference.
   * @param reference The unique reference generated during payment initiation.
   */
  generateReference(prefix: string = 'SP') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  }

  /**
   * Normalizes a phone number to Zambian format (e.g., 097... or 077...)
   * Handles formats like +260..., 260..., 9..., 09...
   */
  normalizePhone(phone: string): string {
    // Remove all non-numeric characters
    let cleaned = phone.replace(/\D/g, '');

    // Handle 260 prefix
    if (cleaned.startsWith('260')) {
      cleaned = cleaned.substring(3);
    }

    // Ensure it starts with 0 (Lenco expects 09... or 07... for Zambia)
    if (!cleaned.startsWith('0')) {
      cleaned = '0' + cleaned;
    }

    return cleaned;
  }

  /**
   * Detects the mobile money operator based on the normalized phone number
   */
  detectOperator(phone: string): string {
    const normalized = this.normalizePhone(phone);

    // Airtel prefixes: 097, 077
    if (normalized.startsWith('097') || normalized.startsWith('077')) {
      return 'airtel';
    }

    // MTN prefixes: 096, 076
    if (normalized.startsWith('096') || normalized.startsWith('076')) {
      return 'mtn';
    }

    // Default to airtel if unknown, or we could throw an error
    return 'airtel';
  }

  async chargeMobileMoney(amount: number, reference: string, phone: string, operator?: string, country: string = 'zm') {
    this.logEnvOnce();
    try {
      const normalizedPhone = this.normalizePhone(phone);
      const detectedOperator = operator || this.detectOperator(normalizedPhone);

      const url = `${this.baseUrl}/collections/mobile-money`;
      console.log(`Lenco charging mobile money: ${normalizedPhone} (${detectedOperator}) URL: ${url}`);

      const response = await axios.post(url, {
        amount,
        reference,
        phone: normalizedPhone,
        operator: detectedOperator,
        country,
        bearer: 'merchant' // Default to merchant bearing the fee
      }, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error('Lenco Mobile Money Charge API Error:', JSON.stringify(error.response.data, null, 2));
        throw error.response.data;
      }
      console.error('Lenco Network Error:', error.message);
      throw new Error(error.message || 'Failed to initiate mobile money collection');
    }
  }

  async verifyTransaction(reference: string) {
    this.logEnvOnce();
    try {
      const url = `${this.baseUrl}/collections/status/${reference}`;
      console.log(`Lenco verifying URL: ${url}`);
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
      });

      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error('Lenco API Error Response:', JSON.stringify(error.response.data, null, 2));
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
    this.logEnvOnce();
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
