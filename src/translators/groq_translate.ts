import { error, info, warn } from '@tauri-apps/plugin-log';
import { groqKeyManager } from '../utils/groq_key_manager';

// Language code mapping for more natural language names
const languageNames: Record<string, string> = {
    'en': 'English',
    'en-US': 'English',
    'en-GB': 'English',
    'ja': 'Japanese',
    'ja-JP': 'Japanese',
    'ko': 'Korean',
    'ko-KR': 'Korean',
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    'es': 'Spanish',
    'es-ES': 'Spanish',
    'fr': 'French',
    'fr-FR': 'French',
    'de': 'German',
    'de-DE': 'German',
    'ru': 'Russian',
    'ru-RU': 'Russian',
    'id': 'Indonesian',
    'ms': 'Malaysian',
    'ar': 'Arabic',
    'it': 'Italian',
    'it-IT': 'Italian',
};

function getLanguageName(code: string): string {
    return languageNames[code] || code;
}

// Maximum number of key fallback attempts
const MAX_FALLBACK_ATTEMPTS = 5;

/**
 * Make a single translation request with a specific API key
 */
async function makeTranslationRequest(
    text: string,
    sourceLang: string,
    targetLang: string,
    apiKey: string,
    styleInstruction: string
): Promise<{ success: boolean; result?: string; isRateLimited?: boolean; retryAfter?: number; error?: string }> {
    const prompt = `Translate the following text from ${sourceLang} to ${targetLang}. ${styleInstruction} Only provide the translation, no explanations or additional text.

Text to translate: "${text}"

Translation:`;

    const url = `https://api.groq.com/openai/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "llama-3.3-70b-versatile",
                messages: [
                    {
                        role: "system",
                        content: "You are a professional translator. Provide only the translation without any explanations or additional text."
                    },
                    {
                        role: "user",
                        content: prompt
                    }
                ],
                temperature: 0.3,
                max_tokens: 1024,
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Check for rate limit (429)
        if (response.status === 429) {
            const retryAfter = parseInt(response.headers.get('retry-after') || '60', 10);
            return { success: false, isRateLimited: true, retryAfter };
        }

        // Check for other errors
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMsg = errorData?.error?.message || `HTTP error! Status: ${response.status}`;
            return { success: false, error: errorMsg };
        }

        const data = await response.json();

        // Validate response
        if (!data?.choices?.length || !data.choices[0]?.message?.content) {
            return { success: false, error: 'Invalid translation response structure' };
        }

        let translatedText = data.choices[0].message.content.trim();

        // Clean up quotes
        if ((translatedText.startsWith('"') && translatedText.endsWith('"')) ||
            (translatedText.startsWith("'") && translatedText.endsWith("'"))) {
            translatedText = translatedText.slice(1, -1);
        }

        if (translatedText.trim() === '' && text.trim() !== '') {
            return { success: false, error: 'Empty translation result' };
        }

        return { success: true, result: translatedText };

    } catch (fetchError: unknown) {
        clearTimeout(timeoutId);
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
            return { success: false, error: 'Translation request timed out' };
        }
        return { success: false, error: fetchError instanceof Error ? fetchError.message : String(fetchError) };
    }
}

/**
 * Translate text using Groq API with automatic key fallback
 * @param text Text to translate
 * @param source Source language code
 * @param target Target language code
 * @param userApiKey Optional user-provided API key (takes priority over built-in keys)
 * @param style Translation style
 */
export default async function translateGroq(
    text: string,
    source: string,
    target: string,
    userApiKey: string = '',
    style: string = 'casual'
): Promise<string> {
    // Skip translation if source and target languages are the same
    if (source === target || source.startsWith(target + '-')) {
        return text;
    }

    const sourceBase = source.includes('-') ? source.split('-')[0] : source;
    if (sourceBase === target) {
        return text;
    }

    const sourceLang = getLanguageName(source);
    const targetLang = getLanguageName(target);

    const styleInstructions: Record<string, string> = {
        'casual': 'Keep the tone casual and natural, as if talking to a friend.',
        'formal': 'Use formal and professional language, appropriate for business or official contexts.',
        'polite': 'Use polite and respectful language, with appropriate honorifics where applicable.',
        'friendly': 'Use warm and friendly language, showing enthusiasm and positivity.'
    };
    const styleInstruction = styleInstructions[style] || styleInstructions['casual'];

    let lastError = '';
    let attempts = 0;
    const triedKeys = new Set<string>();

    while (attempts < MAX_FALLBACK_ATTEMPTS) {
        // Get an available API key (user key takes priority)
        const apiKey = groqKeyManager.getAvailableKey(userApiKey || undefined);

        if (!apiKey) {
            error('[GROQ] No API keys available');
            return `${text} (translation failed: No API keys available)`;
        }

        // Skip if we already tried this key (prevents infinite loop with single key)
        if (triedKeys.has(apiKey) && !userApiKey) {
            warn('[GROQ] All available keys have been tried');
            break;
        }
        triedKeys.add(apiKey);

        info(`[GROQ] Attempting translation (attempt ${attempts + 1}/${MAX_FALLBACK_ATTEMPTS})`);

        const result = await makeTranslationRequest(text, sourceLang, targetLang, apiKey, styleInstruction);

        if (result.success && result.result) {
            groqKeyManager.markKeySuccess(apiKey);
            info(`[GROQ] Translation successful: "${text}" -> "${result.result}"`);
            return result.result;
        }

        if (result.isRateLimited) {
            groqKeyManager.markKeyRateLimited(apiKey, result.retryAfter);
            warn(`[GROQ] Key rate limited, attempting fallback...`);
            
            // If this was a user key, we can't fallback
            if (userApiKey && apiKey === userApiKey) {
                // Try built-in keys as fallback
                const builtinKey = groqKeyManager.getAvailableKey();
                if (builtinKey) {
                    info('[GROQ] User key rate limited, falling back to built-in keys');
                    userApiKey = ''; // Clear user key to use built-in
                } else {
                    lastError = 'API key rate limited, please try again later';
                    break;
                }
            }
        } else {
            groqKeyManager.markKeyFailed(apiKey);
            lastError = result.error || 'Unknown error';
            warn(`[GROQ] Translation failed: ${lastError}`);
        }

        attempts++;
    }

    error(`[GROQ] All translation attempts failed: ${lastError}`);
    return `${text} (translation failed: ${lastError})`;
}
