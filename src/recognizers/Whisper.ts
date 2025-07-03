import { Recognizer } from "./recognizer";
import { info, error } from '@tauri-apps/plugin-log';
import { invoke } from '@tauri-apps/api/core';

export class Whisper extends Recognizer {
    public model: string; // Make it public so we can access it for comparisons
    private selectedMicrophoneId: string | null = null;
    private audioStream: MediaStream | null = null;
    private mediaRecorder: MediaRecorder | null = null;
    private isRecording: boolean = false;
    private audioChunks: Blob[] = [];
    private resultCallback: ((result: string, final: boolean) => void) | null = null;
    private recordingInterval: number = 3000; // Record in 3-second chunks
    private intervalId: NodeJS.Timeout | null = null;

    constructor(lang: string, model: string, microphoneId: string | null = null) {
        super(lang);
        this.model = model;
        this.selectedMicrophoneId = microphoneId;
        
        info(`[WHISPER] Initialized with model: ${model}, language: ${lang}`);
    }

    async start(): Promise<void> {
        try {
            info("[WHISPER] Starting Whisper recognition");
            
            // Check if model is downloaded
            const isDownloaded = await this.isModelDownloaded();
            if (!isDownloaded) {
                error(`[WHISPER] Model ${this.model} is not downloaded`);
                return;
            }

            // Get microphone access
            const constraints: MediaStreamConstraints = {
                audio: { 
                    deviceId: this.selectedMicrophoneId ? { exact: this.selectedMicrophoneId } : undefined,
                    sampleRate: 16000, // Whisper prefers 16kHz
                    channelCount: 1 // Mono audio
                }
            };

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Set up MediaRecorder
            const mimeType = this.getSupportedMimeType();
            this.mediaRecorder = new MediaRecorder(this.audioStream, { mimeType });
            
            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                this.processAudioChunks();
            };

            this.running = true;
            this.startRecordingLoop();
            
            info("[WHISPER] Recognition started successfully");
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error starting recognition: ${errorMessage}`);
            this.running = false;
        }
    }

    stop(): void {
        info("[WHISPER] Stopping Whisper recognition");
        this.running = false;
        this.isRecording = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }

        if (this.audioStream) {
            const tracks = this.audioStream.getTracks();
            tracks.forEach(track => track.stop());
            this.audioStream = null;
        }

        this.mediaRecorder = null;
        this.audioChunks = [];
    }

    restart(): void {
        info("[WHISPER] Restarting Whisper recognition");
        const wasRunning = this.running;
        this.stop();
        
        if (wasRunning) {
            setTimeout(() => {
                this.start();
            }, 1000);
        }
    }

    set_lang(lang: string): void {
        info(`[WHISPER] Setting language to: ${lang}`);
        this.language = lang;
        
        // Restart recognition if it's currently running
        if (this.running) {
            this.restart();
        }
    }

    set_microphone(deviceId: string | null): void {
        info(`[WHISPER] Setting microphone to: ${deviceId || 'default'}`);
        this.selectedMicrophoneId = deviceId;
        
        // Restart recognition if it's currently running
        if (this.running) {
            this.restart();
        }
    }

    status(): boolean {
        return this.running || this.isRecording;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
    }

    setModel(model: string): void {
        info(`[WHISPER] Setting model to: ${model}`);
        this.model = model;
        
        // Restart recognition if it's currently running
        if (this.running) {
            this.restart();
        }
    }

    private startRecordingLoop(): void {
        if (!this.running || !this.mediaRecorder) return;

        const recordChunk = () => {
            if (!this.running || !this.mediaRecorder) return;

            if (this.mediaRecorder.state === 'inactive') {
                this.audioChunks = []; // Clear previous chunks
                this.mediaRecorder.start();
                this.isRecording = true;
                
                // Send interim result to show we're listening
                if (this.resultCallback) {
                    this.resultCallback("", false); // Empty interim result
                }
                
                // Stop recording after interval
                setTimeout(() => {
                    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                        this.mediaRecorder.stop();
                        this.isRecording = false;
                    }
                }, this.recordingInterval);
            }
        };

        // Start first recording immediately
        recordChunk();

        // Set up interval for continuous recording
        this.intervalId = setInterval(recordChunk, this.recordingInterval + 500); // 500ms gap
    }

    private async processAudioChunks(): Promise<void> {
        if (this.audioChunks.length === 0) return;

        try {
            // Combine audio chunks into a single blob
            const audioBlob = new Blob(this.audioChunks, { type: 'audio/wav' });
            this.audioChunks = []; // Clear chunks

            // Convert to ArrayBuffer for processing
            const arrayBuffer = await audioBlob.arrayBuffer();
            const audioData = new Uint8Array(arrayBuffer);

            // Send to Rust backend for Whisper processing
            const result = await invoke('whisper_transcribe', {
                audioData: Array.from(audioData),
                model: this.model,
                language: this.language
            }) as string;

            if (result && result.trim().length > 0 && this.resultCallback) {
                info(`[WHISPER] Transcription result: ${result}`);
                this.resultCallback(result.trim(), true); // Always final with Whisper
            }
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error processing audio: ${errorMessage}`);
        }
    }

    private getSupportedMimeType(): string {
        const mimeTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/wav'
        ];

        for (const mimeType of mimeTypes) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                return mimeType;
            }
        }

        return 'audio/webm'; // Fallback
    }

    private async isModelDownloaded(): Promise<boolean> {
        try {
            const downloaded = await invoke('whisper_is_model_downloaded', {
                model: this.model
            }) as boolean;
            
            return downloaded;
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error checking model download status: ${errorMessage}`);
            return false;
        }
    }

    // Static methods for model management
    static async downloadModel(model: string, _onProgress?: (progress: number) => void): Promise<boolean> {
        try {
            info(`[WHISPER] Starting download for model: ${model}`);
            
            // Add timeout and better error handling
            const downloadPromise = invoke('whisper_download_model', {
                model: model
            });
            
            info(`[WHISPER] Invoking Rust backend for model download: ${model}`);
            const result = await downloadPromise as boolean;
            info(`[WHISPER] Rust backend response for model ${model}: ${result}`);

            if (result === true) {
                info(`[WHISPER] Model ${model} downloaded successfully`);
                return true;
            } else {
                error(`[WHISPER] Failed to download model ${model} - backend returned: ${result}`);
                return false;
            }
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error downloading model ${model}: ${errorMessage}`);
            
            // Log additional error details
            if (err instanceof Error && err.stack) {
                error(`[WHISPER] Error stack trace: ${err.stack}`);
            }
            
            return false;
        }
    }

    static async isModelDownloaded(model: string): Promise<boolean> {
        try {
            const downloaded = await invoke('whisper_is_model_downloaded', {
                model: model
            }) as boolean;
            
            return downloaded;
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error checking model download status: ${errorMessage}`);
            return false;
        }
    }

    static async getDownloadedModels(): Promise<string[]> {
        try {
            const models = await invoke('whisper_get_downloaded_models') as string[];
            return models;
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error getting downloaded models: ${errorMessage}`);
            return [];
        }
    }
}