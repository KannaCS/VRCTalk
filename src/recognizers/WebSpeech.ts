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
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;

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
        
        if (!SpeechRecognition) {
            error("[WEBSPEECH] SpeechRecognition API not available in this browser");
            return;
        }
        
        try {
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
            
            // Reset reconnect attempts when successfully initialized
            this.reconnectAttempts = 0;
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error initializing speech recognition: ${errorMessage}`);
        }
    }

    private handleOnEnd(): void {
        // Only try to restart if we're supposed to be running
        if (this.running) {
            info("[WEBSPEECH] Recognition ended unexpectedly. Restarting...");
            
            // Use exponential backoff for reconnection attempts
            const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
            this.reconnectAttempts++;
            
            if (this.reconnectAttempts <= this.maxReconnectAttempts) {
                info(`[WEBSPEECH] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
                
                setTimeout(() => {
                    try {
                        this.recognition.start();
                        info("[WEBSPEECH] Recognition restarted successfully");
                    } catch (err: unknown) {
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        error(`[WEBSPEECH] Failed to restart recognition: ${errorMessage}`);
                        
                        // If we've failed too many times, reinitialize the recognition object
                        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                            info("[WEBSPEECH] Max reconnect attempts reached, reinitializing recognition");
                            this.initRecognition();
                            
                            // Try one more time after reinitializing
                            setTimeout(() => {
                                try {
                                    if (this.running) {
                                        this.recognition.start();
                                    }
                                } catch (finalErr: unknown) {
                                    const finalErrorMsg = finalErr instanceof Error ? finalErr.message : String(finalErr);
                                    error(`[WEBSPEECH] Final restart attempt failed: ${finalErrorMsg}`);
                                    this.running = false;
                                }
                            }, 1000);
                        }
                    }
                }, delay);
            } else {
                error("[WEBSPEECH] Maximum reconnection attempts reached. Recognition stopped.");
                this.running = false;
            }
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
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Failed to restart recognition after no match: ${errorMessage}`);
                    // Reset running state if restart failed
                    this.running = false;
                }
            }, 500);
        }
    }

    private handleOnError(e: { error?: string }): void {
        if (e.error && e.error.trim().length !== 0) {
            error("[WEBSPEECH] Error: " + e.error);
            
            // Handle specific error types
            if (e.error === 'no-speech') {
                info("[WEBSPEECH] No speech detected, this is normal");
                // No need for special handling, the API will auto-restart
                return;
            } else if (e.error === 'network') {
                error("[WEBSPEECH] Network error occurred");
                // Use longer delay for network errors
                if (this.running) {
                    setTimeout(() => this.restart(), 2000);
                }
                return;
            } else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                error("[WEBSPEECH] Speech recognition permission denied");
                this.running = false;
                return;
            }
        }

        // Only try to restart if we're supposed to be running
        if (this.running) {
            info("[WEBSPEECH] Recovering from error. Restarting...");
            setTimeout(() => {
                try {
                    this.recognition.start();
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Failed to restart recognition after error: ${errorMessage}`);
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
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Error accessing specific microphone: ${errorMessage}. Falling back to default.`);
                    this.selectedMicrophoneId = null;
                }
            }
            
            // Start recognition
            this.recognition.start();
            info("[WEBSPEECH] Recognition started!");
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error starting recognition: ${errorMessage}`);
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
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error stopping recognition: ${errorMessage}`);
        }
    }

    restart(): void {
        info("[WEBSPEECH] Forcing restart of recognition");
        const wasRunning = this.running;
        
        // First stop
        this.stop();
        
        // Reset reconnect attempts on manual restart
        this.reconnectAttempts = 0;
        
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
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                error(`[WEBSPEECH] Error stopping recognition during language change: ${errorMessage}`);
                // Continue anyway to attempt a clean restart
            }
            
            // Reset reconnect attempts on language change
            this.reconnectAttempts = 0;
            
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
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Error recreating recognition instance: ${errorMessage}`);
                    this.running = false;
                    
                    // One final attempt with the original method
                    try {
                        if (wasRunning) {
                            setTimeout(() => {
                                this.start();
                            }, 500);
                        }
                    } catch (finalErr: unknown) {
                        const finalErrorMsg = finalErr instanceof Error ? finalErr.message : String(finalErr);
                        error(`[WEBSPEECH] Fatal error during language change: ${finalErrorMsg}`);
                    }
                }
            }, 300);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error in set_lang: ${errorMessage}`);
        }
    }
    
    set_microphone(deviceId: string | null): void {
        if (deviceId === this.selectedMicrophoneId) return;
        
        debug(`[WEBSPEECH] Changing microphone to ${deviceId || 'default'}`);
        this.selectedMicrophoneId = deviceId;
        
        // Reset reconnect attempts on microphone change
        this.reconnectAttempts = 0;
        
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