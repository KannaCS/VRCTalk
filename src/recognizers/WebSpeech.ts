import { Recognizer } from "./recognizer";
import { info, error, debug } from '@tauri-apps/plugin-log';

declare global {
    interface Window {
        webkitSpeechRecognition: any;
        SpeechRecognition: any;
    }
}

export class WebSpeech extends Recognizer {
    recognition: any;
    audioContext: AudioContext | null = null;
    audioStream: MediaStream | null = null;
    selectedMicrophoneId: string | null = null;
    lang: string;
    resultCallback: ((result: string, final: boolean) => void) | null = null;

    constructor(lang: string, microphoneId: string | null = null) {
        super(lang);
        this.selectedMicrophoneId = microphoneId;
        this.lang = lang;
        
        // Use the standard SpeechRecognition object if available
        this.initRecognition();
    }

    private initRecognition(): void {
        info(`[WEBSPEECH] Initializing recognition with language: ${this.lang}`);
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        this.recognition.interimResults = true;
        this.recognition.maxAlternatives = 1;
        this.recognition.continuous = true;
        this.recognition.lang = this.lang;

        // Set up standard event handlers
        this.recognition.onend = () => this.handleOnEnd();
        this.recognition.onnomatch = () => this.handleOnNoMatch();
        this.recognition.onerror = (e: { error?: string }) => this.handleOnError(e);
        
        // Re-attach the result callback if one was previously set
        if (this.resultCallback) {
            this.recognition.onresult = (event: { results: { [key: number]: { [key: number]: { transcript: string }; isFinal: boolean }; length: number } }) => {
                if (event.results.length > 0) {
                    this.resultCallback!(
                        event.results[event.results.length - 1][0].transcript.trim(),
                        event.results[event.results.length - 1].isFinal
                    );
                }
            };
        }
    }

    private handleOnEnd(): void {
        // Only try to restart if we're supposed to be running
        if (this.running) {
            info("[WEBSPEECH] Recognition ended unexpectedly. Restarting...");
            setTimeout(() => {
                try {
                    this.recognition.start();
                } catch (e) {
                    error(`[WEBSPEECH] Failed to restart recognition: ${e}`);
                    // Reset running state if restart failed
                    this.running = false;
                }
            }, 500);
        } else {
            info("[WEBSPEECH] Recognition ended as expected.");
        }
    }

    private handleOnNoMatch(): void {
        // Only try to restart if we're supposed to be running
        if (this.running) {
            info("[WEBSPEECH] No match. Restarting...");
            setTimeout(() => {
                try {
                    this.recognition.start();
                } catch (e) {
                    error(`[WEBSPEECH] Failed to restart recognition after no match: ${e}`);
                    // Reset running state if restart failed
                    this.running = false;
                }
            }, 500);
        }
    }

    private handleOnError(e: { error?: string }): void {
        if (e.error && e.error.trim().length !== 0) {
            error("[WEBSPEECH] Error: " + e.error);
        }

        // Only try to restart if we're supposed to be running
        if (this.running) {
            info("[WEBSPEECH] Recovering from error. Restarting...");
            setTimeout(() => {
                try {
                    this.recognition.start();
                } catch (e) {
                    error(`[WEBSPEECH] Failed to restart recognition after error: ${e}`);
                    // Reset running state if restart failed
                    this.running = false;
                }
            }, 500);
        }
    }

    async start(): Promise<void> {
        this.running = true;
        try {
            // If a specific microphone is selected, set it as the audio source
            if (this.selectedMicrophoneId) {
                try {
                    // First, we need to get access to the microphone to ensure permissions
                    const constraints: MediaStreamConstraints = {
                        audio: { deviceId: this.selectedMicrophoneId ? { exact: this.selectedMicrophoneId } : undefined }
                    };
                    
                    this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
                    info(`[WEBSPEECH] Using specific microphone: ${this.selectedMicrophoneId}`);
                } catch (e) {
                    error(`[WEBSPEECH] Error accessing specific microphone: ${e}. Falling back to default.`);
                    this.selectedMicrophoneId = null;
                }
            }
            
            // Start recognition
            this.recognition.start();
            info("[WEBSPEECH] Recognition started!");
        } catch (e: unknown) {
            error("[WEBSPEECH] Error starting recognition: " + e);
            // Reset running state if we failed to start
            this.running = false;
        }
    }

    stop(): void {
        this.running = false;
        try {
            this.recognition.stop();
            
            // Clean up audio resources
            if (this.audioStream) {
                const tracks = this.audioStream.getTracks();
                tracks.forEach(track => track.stop());
                this.audioStream = null;
            }
            
            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }
            
            info("[WEBSPEECH] Recognition stopped!");
        } catch (e) {
            error(`[WEBSPEECH] Error stopping recognition: ${e}`);
        }
    }

    restart(): void {
        info("[WEBSPEECH] Forcing restart of recognition");
        const wasRunning = this.running;
        
        // First stop
        this.stop();
        
        // Then start after a delay if it was running
        if (wasRunning) {
            setTimeout(() => {
                this.start();
            }, 500);
        }
    }

    set_lang(lang: string): void {
        try {
            info(`[WEBSPEECH] Setting language from ${this.recognition.lang} to ${lang}`);
            
            // If it's the same language, no need to do anything
            if (this.recognition.lang === lang) {
                info(`[WEBSPEECH] Language is already set to ${lang}, no change needed`);
                return;
            }
            
            this.recognition.lang = lang;
            this.lang = lang;
            
            // For language changes, it's safer to recreate the recognition object completely
            const wasRunning = this.running;
            
            try {
                // First try to stop the current recognition instance
                this.stop();
            } catch (e) {
                error(`[WEBSPEECH] Error stopping recognition during language change: ${e}`);
                // Continue anyway to attempt a clean restart
            }
            
            // Short delay to ensure the previous session is fully terminated
            setTimeout(() => {
                try {
                    info("[WEBSPEECH] Creating new recognition instance for language change");
                    // Clean up any existing resources
                    if (this.audioStream) {
                        const tracks = this.audioStream.getTracks();
                        tracks.forEach(track => track.stop());
                        this.audioStream = null;
                    }
                    
                    if (this.audioContext) {
                        this.audioContext.close();
                        this.audioContext = null;
                    }
                    
                    // Initialize a fresh recognition instance with proper handlers
                    this.initRecognition();
                    
                    // Attempt to start the new instance if recognition was running
                    if (wasRunning) {
                        info("[WEBSPEECH] Restarting recognition with new language");
                        setTimeout(() => {
                            this.start();
                        }, 200);
                    } else {
                        info("[WEBSPEECH] Recognition was not running, language updated");
                    }
                } catch (e) {
                    error(`[WEBSPEECH] Error recreating recognition instance: ${e}`);
                    this.running = false;
                    
                    // One final attempt with the original method
                    try {
                        if (wasRunning) {
                            setTimeout(() => {
                                this.start();
                            }, 500);
                        }
                    } catch (finalError) {
                        error(`[WEBSPEECH] Fatal error during language change: ${finalError}`);
                    }
                }
            }, 300);
        } catch (mainError) {
            error(`[WEBSPEECH] Error in set_lang: ${mainError}`);
        }
    }
    
    set_microphone(deviceId: string | null): void {
        if (deviceId === this.selectedMicrophoneId) return;
        
        debug(`[WEBSPEECH] Changing microphone to ${deviceId || 'default'}`);
        this.selectedMicrophoneId = deviceId;
        
        // Restart recognition with the new microphone
        this.restart();
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
        
        this.recognition.onresult = (event: { results: { [key: number]: { [key: number]: { transcript: string }; isFinal: boolean }; length: number } }) => {
            if (event.results.length > 0) {
                callback(
                    event.results[event.results.length - 1][0].transcript.trim(),
                    event.results[event.results.length - 1].isFinal
                );
            }
        };
    }
} 