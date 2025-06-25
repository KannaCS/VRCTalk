export default async function translateGT(text: string, source: string, target: string): Promise<string> {
    try {
        const encodedText = encodeURIComponent(text.replace(/%/g, '%25'));
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${source}&tl=${target}&dt=t&dt=bd&dj=1&q=${encodedText}`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (!data || !data.sentences || data.sentences.length === 0) {
            throw new Error('Invalid translation response');
        }
        
        let final = '';
        
        // Combine all sentence translations
        for (let i = 0; i < data.sentences.length; i++) {
            if (data.sentences[i].trans) {
                final += (i > 0 ? ' ' : '') + decodeURIComponent(data.sentences[i].trans);
            }
        }
        
        return final;
    } catch (error) {
        console.error('Translation error:', error);
        throw error;
    }
} 