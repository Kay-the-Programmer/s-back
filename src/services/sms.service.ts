import axios from 'axios';

/**
 * Africa's Talking SMS integration.
 *
 * Credentials are platform-level (one Africa's Talking account serves every
 * store) and read from the environment:
 *   AT_API_KEY            – Africa's Talking API key (required)
 *   AT_USERNAME           – AT username ("sandbox" for the test account)
 *   AT_SENDER_ID          – optional alphanumeric/shortcode sender id
 *   AT_DEFAULT_COUNTRY_CODE – fallback country dialling code, default 260 (Zambia)
 *
 * The sandbox endpoint is used automatically when the username is "sandbox".
 */
export interface SmsRecipientResult {
    number: string;
    status: string;
    statusCode?: number;
    messageId?: string;
    cost?: string;
}

export interface SmsSendResult {
    message: string;          // AT summary, e.g. "Sent to 1/1 Total Cost: KES 0.8000"
    recipients: SmsRecipientResult[];
}

export class AfricasTalkingService {
    private _loggedEnv = false;

    private getApiKey(): string { return process.env.AT_API_KEY || ''; }
    private getUsername(): string { return process.env.AT_USERNAME || 'sandbox'; }
    private getSenderId(): string | undefined { return process.env.AT_SENDER_ID || undefined; }
    private getDefaultCountryCode(): string { return (process.env.AT_DEFAULT_COUNTRY_CODE || '260').replace(/\D/g, ''); }

    /** True when the username is the shared sandbox account. */
    isSandbox(): boolean { return this.getUsername().toLowerCase() === 'sandbox'; }

    /** Whether the integration has the minimum config to send. */
    isConfigured(): boolean { return !!this.getApiKey() && !!this.getUsername(); }

    private getBaseUrl(): string {
        return this.isSandbox()
            ? 'https://api.sandbox.africastalking.com/version1/messaging'
            : 'https://api.africastalking.com/version1/messaging';
    }

    /** Public, secret-free view of the config for the frontend. */
    publicConfig() {
        return { configured: this.isConfigured(), sandbox: this.isSandbox(), senderId: this.getSenderId() || null };
    }

    private logEnvOnce() {
        if (this._loggedEnv) return;
        this._loggedEnv = true;
        const key = this.getApiKey();
        const masked = key ? `${key.substring(0, 6)}...${key.substring(key.length - 4)}` : 'NOT SET';
        console.log(`[AfricasTalking] username=${this.getUsername()} sandbox=${this.isSandbox()} senderId=${this.getSenderId() || '(default)'} key=${masked}`);
        if (!this.isConfigured()) console.warn('⚠️ Africa\'s Talking SMS is not configured (AT_API_KEY / AT_USERNAME missing).');
    }

    /**
     * Normalise a local or international number to E.164 (e.g. +2609XXXXXXXX),
     * defaulting unknown local numbers to the configured country code.
     */
    normalizePhone(phone: string): string {
        if (!phone) return '';
        const trimmed = phone.trim();
        const hadPlus = trimmed.startsWith('+');
        let digits = trimmed.replace(/\D/g, '');
        if (!digits) return '';
        const cc = this.getDefaultCountryCode();

        if (hadPlus) return `+${digits}`;
        if (digits.startsWith('00')) return `+${digits.substring(2)}`;
        if (digits.startsWith(cc)) return `+${digits}`;
        if (digits.startsWith('0')) return `+${cc}${digits.substring(1)}`;
        // Bare national number (e.g. 9XXXXXXXX) — prefix the country code.
        return `+${cc}${digits}`;
    }

    /**
     * Send an SMS to one or more recipients via Africa's Talking.
     * @throws an object/Error describing the failure for the controller to surface.
     */
    async sendSms(to: string | string[], message: string, from?: string): Promise<SmsSendResult> {
        this.logEnvOnce();
        if (!this.isConfigured()) {
            const err: any = new Error('SMS service is not configured.');
            err.code = 'SMS_NOT_CONFIGURED';
            throw err;
        }

        const recipients = (Array.isArray(to) ? to : [to])
            .map(n => this.normalizePhone(n))
            .filter(Boolean);
        if (recipients.length === 0) {
            const err: any = new Error('No valid recipient phone number.');
            err.code = 'SMS_NO_RECIPIENT';
            throw err;
        }

        const body = new URLSearchParams();
        body.append('username', this.getUsername());
        body.append('to', recipients.join(','));
        body.append('message', message);
        const sender = from || this.getSenderId();
        if (sender) body.append('from', sender);

        try {
            const response = await axios.post(this.getBaseUrl(), body.toString(), {
                headers: {
                    apiKey: this.getApiKey(),
                    Accept: 'application/json',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 20000,
            });

            const data = response.data?.SMSMessageData;
            const recps: SmsRecipientResult[] = (data?.Recipients || []).map((r: any) => ({
                number: r.number,
                status: r.status,
                statusCode: r.statusCode,
                messageId: r.messageId,
                cost: r.cost,
            }));
            return { message: data?.Message || 'Sent', recipients: recps };
        } catch (error: any) {
            if (error.response) {
                console.error('[AfricasTalking] API error:', JSON.stringify(error.response.data));
                const e: any = new Error(
                    typeof error.response.data === 'string'
                        ? error.response.data
                        : (error.response.data?.message || 'Africa\'s Talking rejected the request.'),
                );
                e.code = 'SMS_PROVIDER_ERROR';
                e.status = error.response.status;
                throw e;
            }
            console.error('[AfricasTalking] Network error:', error.message);
            const e: any = new Error(error.message || 'Failed to reach the SMS provider.');
            e.code = error.code || 'SMS_NETWORK_ERROR';
            throw e;
        }
    }
}

export const smsService = new AfricasTalkingService();
export default smsService;
