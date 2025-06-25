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

    constructor(lang: string, microphoneId: string | null = null) {
        super(lang);
        this.selectedMicrophoneId = microphoneId;
        
        // Use the standard SpeechRecognition object if available
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.recognition = new SpeechRecognition();
        this.recognition.interimResults = true;
        this.recognition.maxAlternatives = 1;
        this.recognition.continuous = true;
        this.recognition.lang = lang;
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

        this.recognition.onend = () => {
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
        };

        this.recognition.onnomatch = () => {
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
        };

        this.recognition.onerror = (e: { error?: string }) => {
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
        };
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
        this.recognition.lang = lang;
        debug("[WEBSPEECH] Language set to " + lang);
        this.restart();
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