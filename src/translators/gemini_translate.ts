import { error, info } from '@tauri-apps/plugin-log';

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

export default async function translateGemini(
    text: string,
    source: string,
    target: string,
    apiKey: string,
    style: string = 'casual'
): Promise<string> {
    try {
        // Validate API key
        if (!apiKey || apiKey.trim() === '') {
            throw new Error('Gemini API key is not configured');
        }

        // Skip translation if source and target languages are the same
        if (source === target || source.startsWith(target + '-')) {
            return text;
        }

        // Handle source language with region code (e.g., 'en-US' -> 'en')
        const sourceBase = source.includes('-') ? source.split('-')[0] : source;
        
        // If source base language is the same as target, no need to translate
        if (sourceBase === target) {
            return text;
        }

        const sourceLang = getLanguageName(source);
        const targetLang = getLanguageName(target);

        // Build style instruction
        const styleInstructions: Record<string, string> = {
            'casual': 'Keep the tone casual and natural, as if talking to a friend.',
            'formal': 'Use formal and professional language, appropriate for business or official contexts.',
            'polite': 'Use polite and respectful language, with appropriate honorifics where applicable.',
            'friendly': 'Use warm and friendly language, showing enthusiasm and positivity.'
        };
        const styleInstruction = styleInstructions[style] || styleInstructions['casual'];

        // Build the prompt for translation
        const prompt = `Translate the following text from ${sourceLang} to ${targetLang}. ${styleInstruction} Only provide the translation, no explanations or additional text.

Text to translate: "${text}"

Translation:`;

        // Gemini API endpoint (using 1.5-flash-latest for free tier)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;

        // Set a timeout for the fetch request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 1024,
                    },
                    safetySettings: [
                        {
                            category: "HARM_CATEGORY_HARASSMENT",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_HATE_SPEECH",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                            threshold: "BLOCK_NONE"
                        },
                        {
                            category: "HARM_CATEGORY_DANGEROUS_CONTENT",
                            threshold: "BLOCK_NONE"
                        }
                    ]
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Check if response is ok
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMsg = errorData?.error?.message || `HTTP error! Status: ${response.status}`;
                throw new Error(errorMsg);
            }

            const data = await response.json();

            // Validate response data
            if (!data || !data.candidates || data.candidates.length === 0) {
                throw new Error('Invalid translation response structure');
            }

            // Extract the translation from the response
            const candidate = data.candidates[0];
            if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
                throw new Error('No translation content in response');
            }

            let translatedText = candidate.content.parts[0].text || '';
            
            // Clean up the response - remove quotes if present
            translatedText = translatedText.trim();
            if ((translatedText.startsWith('"') && translatedText.endsWith('"')) ||
                (translatedText.startsWith("'") && translatedText.endsWith("'"))) {
                translatedText = translatedText.slice(1, -1);
            }

            // If we got an empty result but had input text, something went wrong
            if (translatedText.trim() === '' && text.trim() !== '') {
                throw new Error('Empty translation result');
            }

            info(`[GEMINI] Translation successful: "${text}" -> "${translatedText}"`);
            return translatedText;

        } catch (fetchError: unknown) {
            // Handle fetch-specific errors
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                throw new Error('Translation request timed out');
            }
            throw fetchError;
        }
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        error(`[GEMINI] Error: ${errorMessage}`);
        
        // Return original text with error indication as fallback
        return `${text} (translation failed: ${errorMessage})`;
    }
}
