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
    private lastActivityTime: number = Date.now();
    private healthCheckInterval: any = null;
    private maxIdleTime: number = 30000; // 30 seconds

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
            this.recognition.onstart = () => this.handleOnStart();
            
            // Re-attach the result callback if one was previously set
            if (this.resultCallback) {
                this.recognition.onresult = (event: { results: { [key: number]: { [key: number]: { transcript: string }; isFinal: boolean }; length: number } }) => {
                    if (event.results.length > 0) {
                        // Update activity time on every result
                        this.lastActivityTime = Date.now();
                        // Reset reconnect attempts on successful transcription
                        this.reconnectAttempts = 0;
                        
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

    private handleOnStart(): void {
        info("[WEBSPEECH] Recognition started successfully");
        this.lastActivityTime = Date.now();
        this.reconnectAttempts = 0;
    }

    private handleOnEnd(): void {
        // Always check if we should be running, regardless of this.running state
        // This handles cases where recognition stops due to timeout/idle
        const shouldBeRunning = this.running;
        
        if (shouldBeRunning) {
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
        this.lastActivityTime = Date.now();
        this.reconnectAttempts = 0;
        
        // Start health check
        this.startHealthCheck();
        
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
        
        // Stop health check
        this.stopHealthCheck();
        
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
        
        try {
            // First stop and clean up any existing resources
            this.stop();
            
            // Reset state
            this.reconnectAttempts = 0;
            this.running = false;
            
            // Ensure any audio resources are properly cleaned up
            if (this.audioStream) {
                const tracks = this.audioStream.getTracks();
                tracks.forEach(track => track.stop());
                this.audioStream = null;
            }
            
            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }
            
            // Reinitialize the recognition object to ensure a clean slate
            info("[WEBSPEECH] Reinitializing recognition object during restart");
            this.initRecognition();
            
            // Then start after a delay if it was running
            if (wasRunning) {
                this.running = true;
                setTimeout(() => {
                    try {
                        info("[WEBSPEECH] Starting recognition after restart");
                        this.start();
                    } catch (err: unknown) {
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        error(`[WEBSPEECH] Error starting recognition after restart: ${errorMessage}`);
                        
                        // One final attempt with a longer delay
                        setTimeout(() => {
                            try {
                                info("[WEBSPEECH] Final attempt to start recognition");
                                this.start();
                            } catch (finalErr: unknown) {
                                const finalErrorMsg = finalErr instanceof Error ? finalErr.message : String(finalErr);
                                error(`[WEBSPEECH] Final restart attempt failed: ${finalErrorMsg}`);
                                this.running = false;
                            }
                        }, 1000);
                    }
                }, 500);
            }
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error during restart: ${errorMessage}`);
            
            // Attempt recovery
            this.reconnectAttempts = 0;
            this.initRecognition();
            
            if (wasRunning) {
                this.running = true;
                setTimeout(() => this.start(), 1000);
            }
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
            info(`[WEBSPEECH] Language change - was running: ${wasRunning}`);
            
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
                    
                    // Always restart recognition after language change if it was running before
                    if (wasRunning) {
                        info("[WEBSPEECH] Restarting recognition with new language");
                        this.running = true; // Ensure running state is set before starting
                        setTimeout(() => {
                            this.start();
                        }, 200);
                    } else {
                        info("[WEBSPEECH] Recognition was not running, language updated");
                    }
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Error recreating recognition instance: ${errorMessage}`);
                    
                    // One final attempt with the original method
                    try {
                        if (wasRunning) {
                            info("[WEBSPEECH] Attempting final restart after error");
                            this.running = true; // Ensure running state is set
                            setTimeout(() => {
                                this.start();
                            }, 500);
                        }
                    } catch (finalErr: unknown) {
                        const finalErrorMsg = finalErr instanceof Error ? finalErr.message : String(finalErr);
                        error(`[WEBSPEECH] Fatal error during language change: ${finalErrorMsg}`);
                        this.running = false;
                    }
                }
            }, 300);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error in set_lang: ${errorMessage}`);
        }
    }
    
    set_microphone(deviceId: string | null): void {
        if (deviceId === this.selectedMicrophoneId) {
            debug(`[WEBSPEECH] Microphone unchanged: ${deviceId || 'default'}`);
            return;
        }
        
        info(`[WEBSPEECH] Changing microphone from ${this.selectedMicrophoneId || 'default'} to ${deviceId || 'default'}`);
        this.selectedMicrophoneId = deviceId;
        
        // Reset reconnect attempts on microphone change
        this.reconnectAttempts = 0;
        
        // Check if the microphone is available before restarting
        if (deviceId) {
            navigator.mediaDevices.enumerateDevices()
                .then(devices => {
                    const audioInputs = devices.filter(device => device.kind === "audioinput");
                    const selectedDevice = audioInputs.find(device => device.deviceId === deviceId);
                    
                    if (selectedDevice) {
                        info(`[WEBSPEECH] Found selected microphone: ${selectedDevice.label || deviceId}`);
                        // Restart recognition with the new microphone
                        this.restart();
                    } else {
                        error(`[WEBSPEECH] Error: Selected microphone ${deviceId} not found in available devices`);
                        const availableMics = audioInputs.map(device => `${device.label || 'Unnamed'} (${device.deviceId.substring(0, 8)}...)`).join(', ');
                        error(`[WEBSPEECH] Available microphones: ${availableMics || 'None'}`);
                        
                        // Fall back to default microphone
                        info(`[WEBSPEECH] Falling back to default microphone`);
                        this.selectedMicrophoneId = null;
                        this.restart();
                    }
                })
                .catch(err => {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Error accessing media devices when changing microphone: ${errorMessage}`);
                    // Fall back to default microphone
                    info(`[WEBSPEECH] Falling back to default microphone due to error`);
                    this.selectedMicrophoneId = null;
                    this.restart();
                });
        } else {
            // If deviceId is null, we're intentionally using the default microphone
            info(`[WEBSPEECH] Using default system microphone`);
            this.restart();
        }
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
        
        this.recognition.onresult = (event: { results: { [key: number]: { [key: number]: { transcript: string }; isFinal: boolean }; length: number } }) => {
            if (event.results.length > 0) {
                // Update activity time and reset reconnect attempts on every result
                this.lastActivityTime = Date.now();
                this.reconnectAttempts = 0;
                
                callback(
                    event.results[event.results.length - 1][0].transcript.trim(),
                    event.results[event.results.length - 1].isFinal
                );
            }
        };
    }

    private startHealthCheck(): void {
        // Clear any existing health check
        this.stopHealthCheck();
        
        // Check every 10 seconds if recognition is still active
        this.healthCheckInterval = setInterval(() => {
            if (!this.running) {
                // If we're not supposed to be running, stop the health check
                this.stopHealthCheck();
                return;
            }
            
            const timeSinceLastActivity = Date.now() - this.lastActivityTime;
            
            // If recognition has been idle for too long, restart it
            if (timeSinceLastActivity > this.maxIdleTime) {
                info(`[WEBSPEECH] Health check: Recognition idle for ${timeSinceLastActivity}ms. Restarting...`);
                this.lastActivityTime = Date.now();
                
                try {
                    // Try to stop and restart
                    this.recognition.stop();
                    setTimeout(() => {
                        if (this.running) {
                            try {
                                this.recognition.start();
                                info("[WEBSPEECH] Health check: Recognition restarted successfully");
                            } catch (err: unknown) {
                                const errorMessage = err instanceof Error ? err.message : String(err);
                                error(`[WEBSPEECH] Health check: Failed to restart: ${errorMessage}`);
                                
                                // If restart fails, try reinitializing
                                this.initRecognition();
                                setTimeout(() => {
                                    if (this.running) {
                                        this.recognition.start();
                                    }
                                }, 500);
                            }
                        }
                    }, 500);
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Health check: Error during restart: ${errorMessage}`);
                }
            }
        }, 10000); // Check every 10 seconds
        
        info("[WEBSPEECH] Health check started");
    }

    private stopHealthCheck(): void {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            info("[WEBSPEECH] Health check stopped");
        }
    }
} 