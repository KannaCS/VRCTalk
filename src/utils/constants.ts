// Language options for source language
export const langSource = [
    { code: "en-US", name: "English (US)" },
    { code: "en-GB", name: "English (UK)" },
    { code: "ja", name: "Japanese" },
    { code: "zh-CN", name: "Chinese (Simplified)" },
    { code: "zh-TW", name: "Chinese (Traditional)" },
    { code: "ko", name: "Korean" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "it", name: "Italian" },
    { code: "es", name: "Spanish" },
    { code: "ru", name: "Russian" },
];

// Language options for target language
export const langTo = [
    { code: "en", name: "English" },
    { code: "ja", name: "Japanese" },
    { code: "zh-CN", name: "Chinese (Simplified)" },
    { code: "zh-TW", name: "Chinese (Traditional)" },
    { code: "ko", name: "Korean" },
    { code: "fr", name: "French" },
    { code: "de", name: "German" },
    { code: "it", name: "Italian" },
    { code: "es", name: "Spanish" },
    { code: "ru", name: "Russian" },
];

/**
 * Calculate minimum wait time based on text length and speed setting
 */
export function calculateMinWaitTime(text: string, speed: number): number {
    // Base time + additional time based on text length
    return speed + Math.max(0, text.length - 10) * (speed / 20);
}

/**
 * Find the index of a language in the source languages array
 */
export function findLangSourceIndex(code: string): number {
    return langSource.findIndex(lang => lang.code === code) || 0;
}

/**
 * Find the index of a language in the target languages array
 */
export function findLangToIndex(code: string): number {
    return langTo.findIndex(lang => lang.code === code) || 0;
} 