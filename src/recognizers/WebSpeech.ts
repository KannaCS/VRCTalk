import { Recognizer } from "./recognizer";
import { info, error, debug } from '@tauri-apps/plugin-log';

declare global {
    interface Window {
        webkitSpeechRecognition: any;
    }
}

export class WebSpeech extends Recognizer {
    recognition: any;

    constructor(lang: string) {
        super(lang);

        this.recognition = new window.webkitSpeechRecognition();
        this.recognition.interimResults = true;
        this.recognition.maxAlternatives = 1;
        this.recognition.continuous = true;
        this.recognition.lang = lang;
    }

    start(): void {
        this.running = true;
        try {
            this.recognition.start();
            info("[WEBSPEECH] Recognition started!");
        } catch (e: unknown) {
            error("[WEBSPEECH] Error starting recognition: " + e);
        }

        this.recognition.onend = () => {
            if (this.running) {
                setTimeout(() => {
                    try {
                        this.recognition.start();
                    } catch {
                        // Silent error handling
                    }
                }, 500);
            }
        };

        this.recognition.onnomatch = () => {
            if (this.running) {
                setTimeout(() => {
                    try {
                        this.recognition.start();
                    } catch {
                        // Silent error handling
                    }
                }, 500);
            }
        };

        this.recognition.onerror = (e: { error?: string }) => {
            if (e.error && e.error.trim().length !== 0) {
                error("[WEBSPEECH] Error: " + e.error);
            }

            if (this.running) {
                setTimeout(() => {
                    try {
                        this.recognition.start();
                    } catch {
                        // Silent error handling
                    }
                }, 500);
            }
        };
    }

    stop(): void {
        this.running = false;
        this.recognition.stop();
        info("[WEBSPEECH] Recognition stopped!");
    }

    set_lang(lang: string): void {
        this.recognition.lang = lang;
        debug("[WEBSPEECH] Language set to " + lang);
        this.recognition.stop();

        debug("[WEBSPEECH] Restarting in 500ms...");
        setTimeout(() => {
            this.recognition.start();
        }, 500);
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.recognition.onresult = (event: { results: { [x: number]: { [x: number]: { transcript: string }; isFinal: boolean } } }) => {
            if (event.results.length > 0) {
                callback(
                    event.results[event.results.length - 1][0].transcript.trim(),
                    event.results[event.results.length - 1].isFinal
                );
            }
        };
    }
} 