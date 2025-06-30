import { error } from '@tauri-apps/plugin-log';

export default async function translateGT(text: string, source: string, target: string): Promise<string> {
    try {
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
        
        // Encode the text properly for the URL
        const encodedText = encodeURIComponent(text.replace(/%/g, '%25'));
        
        // Build the Google Translate API URL
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&dt=bd&dj=1&q=${encodedText}`;
        
        // Set a timeout for the fetch request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
        
        try {
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            // Check if response is ok
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            
            const data = await response.json();
            
            // Validate response data
            if (!data || !data.sentences || data.sentences.length === 0) {
                throw new Error('Invalid translation response structure');
            }
            
            // Combine all sentence translations
            let final = '';
            for (let i = 0; i < data.sentences.length; i++) {
                if (data.sentences[i].trans) {
                    final += (i > 0 ? ' ' : '') + decodeURIComponent(data.sentences[i].trans);
                }
            }
            
            // If we got an empty result but had input text, something went wrong
            if (final.trim() === '' && text.trim() !== '') {
                throw new Error('Empty translation result');
            }
            
            return final;
        } catch (fetchError: unknown) {
            // Handle fetch-specific errors
            if (fetchError instanceof Error && fetchError.name === 'AbortError') {
                throw new Error('Translation request timed out');
            }
            throw fetchError;
        }
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        error(`[TRANSLATE] Error: ${errorMessage}`);
        
        // Return original text as fallback
        return `${text} (translation failed)`;
    }
} 