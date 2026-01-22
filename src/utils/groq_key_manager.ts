import { info, warn } from '@tauri-apps/plugin-log';

// Built-in API keys provided by the app (loaded from environment variable at build time)
// Users can still provide their own key which takes priority
// Keys are comma-separated in VITE_GROQ_API_KEYS environment variable
const BUILTIN_GROQ_KEYS: string[] = (import.meta.env.VITE_GROQ_API_KEYS || '')
    .split(',')
    .map((key: string) => key.trim())
    .filter((key: string) => key.length > 0);

interface KeyStatus {
    key: string;
    isRateLimited: boolean;
    rateLimitedUntil: number; // Timestamp when rate limit expires
    consecutiveFailures: number;
}

class GroqKeyManager {
    private keyStatuses: Map<string, KeyStatus> = new Map();
    private currentKeyIndex: number = 0;
    private readonly RATE_LIMIT_COOLDOWN_MS = 60000; // 1 minute cooldown for rate-limited keys
    private readonly MAX_CONSECUTIVE_FAILURES = 3;

    constructor() {
        this.initializeKeys();
    }

    private initializeKeys(): void {
        BUILTIN_GROQ_KEYS.forEach(key => {
            if (key && key.trim()) {
                this.keyStatuses.set(key, {
                    key,
                    isRateLimited: false,
                    rateLimitedUntil: 0,
                    consecutiveFailures: 0
                });
            }
        });
        info(`[GROQ_KEY_MANAGER] Initialized with ${this.keyStatuses.size} built-in keys`);
    }

    /**
     * Get the next available API key
     * @param userKey Optional user-provided key (takes priority)
     * @returns Available API key or null if none available
     */
    getAvailableKey(userKey?: string): string | null {
        const now = Date.now();

        // If user provided a key, always try it first
        if (userKey && userKey.trim()) {
            info('[GROQ_KEY_MANAGER] Using user-provided API key');
            return userKey.trim();
        }

        // Check if we have any built-in keys
        if (this.keyStatuses.size === 0) {
            warn('[GROQ_KEY_MANAGER] No built-in keys available');
            return null;
        }

        // Reset rate limits that have expired
        this.keyStatuses.forEach((status, key) => {
            if (status.isRateLimited && now >= status.rateLimitedUntil) {
                info(`[GROQ_KEY_MANAGER] Rate limit expired for key ending in ...${key.slice(-4)}`);
                status.isRateLimited = false;
                status.consecutiveFailures = 0;
            }
        });

        // Find an available key using round-robin
        const keys = Array.from(this.keyStatuses.keys());
        const startIndex = this.currentKeyIndex;

        for (let i = 0; i < keys.length; i++) {
            const index = (startIndex + i) % keys.length;
            const key = keys[index];
            const status = this.keyStatuses.get(key)!;

            if (!status.isRateLimited && status.consecutiveFailures < this.MAX_CONSECUTIVE_FAILURES) {
                this.currentKeyIndex = (index + 1) % keys.length;
                info(`[GROQ_KEY_MANAGER] Selected built-in key ending in ...${key.slice(-4)}`);
                return key;
            }
        }

        // All keys are rate limited, try to find the one with shortest wait
        let shortestWait = Infinity;
        let bestKey: string | null = null;

        this.keyStatuses.forEach((status, key) => {
            const waitTime = status.rateLimitedUntil - now;
            if (waitTime < shortestWait) {
                shortestWait = waitTime;
                bestKey = key;
            }
        });

        if (bestKey && shortestWait <= 0) {
            const status = this.keyStatuses.get(bestKey)!;
            status.isRateLimited = false;
            status.consecutiveFailures = 0;
            return bestKey;
        }

        warn(`[GROQ_KEY_MANAGER] All keys rate limited. Shortest wait: ${Math.ceil(shortestWait / 1000)}s`);
        return null;
    }

    /**
     * Mark a key as rate limited
     * @param key The API key that was rate limited
     * @param retryAfterSeconds Optional retry-after header value in seconds
     */
    markKeyRateLimited(key: string, retryAfterSeconds?: number): void {
        // Don't track user keys in the manager
        if (!this.keyStatuses.has(key)) {
            warn('[GROQ_KEY_MANAGER] User-provided key was rate limited');
            return;
        }

        const cooldown = retryAfterSeconds 
            ? retryAfterSeconds * 1000 
            : this.RATE_LIMIT_COOLDOWN_MS;

        const status = this.keyStatuses.get(key)!;
        status.isRateLimited = true;
        status.rateLimitedUntil = Date.now() + cooldown;
        status.consecutiveFailures++;

        warn(`[GROQ_KEY_MANAGER] Key ending in ...${key.slice(-4)} rate limited for ${cooldown / 1000}s`);
    }

    /**
     * Mark a key as having a successful request
     * @param key The API key that succeeded
     */
    markKeySuccess(key: string): void {
        if (this.keyStatuses.has(key)) {
            const status = this.keyStatuses.get(key)!;
            status.consecutiveFailures = 0;
            status.isRateLimited = false;
        }
    }

    /**
     * Mark a key as having failed (non-rate-limit error)
     * @param key The API key that failed
     */
    markKeyFailed(key: string): void {
        if (this.keyStatuses.has(key)) {
            const status = this.keyStatuses.get(key)!;
            status.consecutiveFailures++;
            
            if (status.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
                warn(`[GROQ_KEY_MANAGER] Key ending in ...${key.slice(-4)} disabled after ${this.MAX_CONSECUTIVE_FAILURES} failures`);
            }
        }
    }

    /**
     * Check if built-in keys are available
     */
    hasBuiltinKeys(): boolean {
        return this.keyStatuses.size > 0;
    }

    /**
     * Get the count of available (non-rate-limited) built-in keys
     */
    getAvailableKeyCount(): number {
        const now = Date.now();
        let count = 0;
        
        this.keyStatuses.forEach(status => {
            const isAvailable = !status.isRateLimited || now >= status.rateLimitedUntil;
            const notTooManyFailures = status.consecutiveFailures < this.MAX_CONSECUTIVE_FAILURES;
            if (isAvailable && notTooManyFailures) {
                count++;
            }
        });
        
        return count;
    }

    /**
     * Get total number of built-in keys
     */
    getTotalKeyCount(): number {
        return this.keyStatuses.size;
    }

    /**
     * Add a new built-in key at runtime
     * @param key The API key to add
     */
    addKey(key: string): void {
        if (key && key.trim() && !this.keyStatuses.has(key)) {
            this.keyStatuses.set(key, {
                key,
                isRateLimited: false,
                rateLimitedUntil: 0,
                consecutiveFailures: 0
            });
            info(`[GROQ_KEY_MANAGER] Added new key ending in ...${key.slice(-4)}`);
        }
    }

    /**
     * Reset all key statuses
     */
    resetAllKeys(): void {
        this.keyStatuses.forEach(status => {
            status.isRateLimited = false;
            status.rateLimitedUntil = 0;
            status.consecutiveFailures = 0;
        });
        this.currentKeyIndex = 0;
        info('[GROQ_KEY_MANAGER] All key statuses reset');
    }
}

// Singleton instance
export const groqKeyManager = new GroqKeyManager();

// Export for adding keys programmatically
export function addGroqKey(key: string): void {
    groqKeyManager.addKey(key);
}

// Export for checking availability
export function hasBuiltinGroqKeys(): boolean {
    return groqKeyManager.hasBuiltinKeys();
}
