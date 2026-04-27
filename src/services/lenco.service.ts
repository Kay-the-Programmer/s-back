import axios from 'axios';

export class LencoService {
  private _baseUrl: string | null = null;
  private _secretKey: string | null = null;
  private _loggedEnv = false;

  private getBaseUrl(secretKey?: string): string {
    const envUrl = process.env.LENCO_API_BASE_URL;
    const key = secretKey || this.getSecretKey();

    if (envUrl) {
      return envUrl.replace(/\/+$/, '');
    }

    // Auto-detect based on key
    if (key.startsWith('sk_test') || key.startsWith('851685')) { // Known sandbox prefix for this user
      return 'https://sandbox.lenco.co/access/v2';
    } else {
      return 'https://api.lenco.co/access/v2';
    }
  }

  private getSecretKey(): string {
    return process.env.LENCO_SECRET_KEY || '';
  }

  private logEnvOnce(secretKey?: string) {
    if (this._loggedEnv) return;
    this._loggedEnv = true;

    const key = secretKey || this.getSecretKey();
    const maskedKey = key ? `${key.substring(0, 6)}...${key.substring(key.length - 4)}` : 'NOT SET';
    const currentBaseUrl = this.getBaseUrl(key);

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

  async chargeMobileMoney(amount: number, reference: string, phone: string, operator?: string, country: string = 'zm', secretKey?: string) {
    const key = secretKey || this.getSecretKey();
    this.logEnvOnce(key);
    try {
      const normalizedPhone = this.normalizePhone(phone);
      const detectedOperator = operator || this.detectOperator(normalizedPhone);

      const baseUrl = this.getBaseUrl(key);
      const url = `${baseUrl}/collections/mobile-money`;
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
          Authorization: `Bearer ${key}`,
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

  async verifyTransaction(reference: string, secretKey?: string) {
    const key = secretKey || this.getSecretKey();
    this.logEnvOnce(key);
    try {
      const baseUrl = this.getBaseUrl(key);
      const url = `${baseUrl}/collections/status/${reference}`;
      console.log(`Lenco verifying URL: ${url}`);
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${key}`,
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
   * Attempt to cancel a transaction (Best effort)
   * @param reference The transaction reference
   */
  async cancelTransaction(reference: string, secretKey?: string) {
    const key = secretKey || this.getSecretKey();
    this.logEnvOnce(key);
    try {
      // Note: Lenco public API doesn't explicitly document a cancellation endpoint for mobile money.
      // This is a best-effort attempt to notify them if such an endpoint exists (un-documented/future-proof).
      // We also log it so we can track if users are cancelling frequently.
      console.log(`[LencoService] Cancellation requested for reference: ${reference}`);

      const baseUrl = this.getBaseUrl(key);
      const url = `${baseUrl}/collections/status/${reference}/cancel`;
      await axios.post(url, {}, {
        headers: {
          Authorization: `Bearer ${key}`,
          'Accept': 'application/json',
        },
      }).catch(err => {
        // Silently fail if not supported - 404/405 is expected if undocumented
        if (err.response?.status !== 404 && err.response?.status !== 405) {
          console.warn(`[LencoService] Unexpected error during cancellation attempt for ${reference}:`, err.message);
        }
      });
    } catch (error: any) {
      console.error('[LencoService] Error in cancelTransaction:', error.message);
    }
  }

  /**
   * Get banks list
   * @param country country code i.e zm
   */
  async getBanks(country: string = 'zm', secretKey?: string) {
    const key = secretKey || this.getSecretKey();
    this.logEnvOnce(key);
    try {
      const baseUrl = this.getBaseUrl(key);
      const response = await axios.get(`${baseUrl}/banks?country=${country}`, {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      return response.data;
    } catch (error: any) {
      console.error('Error fetching banks:', error.response?.data || error.message);
      throw new Error(error.response?.data?.message || 'Failed to fetch banks');
    }
  }
}

export const lencoService = new LencoService();
export default lencoService;
