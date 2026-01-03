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
    private recordingInterval: number = 3000; // 3s chunks to reduce silence and hallucinations
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
                const errorMsg = `Model ${this.model} is not downloaded. Please download it in Settings.`;
                error(`[WHISPER] ${errorMsg}`);
                if (this.resultCallback) {
                    this.resultCallback(`Error: ${errorMsg}`, true);
                }
                return;
            }

            // Get microphone access
            // Don't constrain sample rate - let browser use native rate, we'll resample later
            const constraints: MediaStreamConstraints = {
                audio: {
                    deviceId: this.selectedMicrophoneId ? { exact: this.selectedMicrophoneId } : undefined,
                    channelCount: 1, // Prefer mono audio
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
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
            
            // Report error to UI
            if (this.resultCallback) {
                this.resultCallback(`Error starting Whisper: ${errorMessage}`, true);
            }
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
                    this.resultCallback("Listening...", false); // Show listening status
                }

                // Stop recording after interval
                setTimeout(() => {
                    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
                        this.mediaRecorder.stop();
                        this.isRecording = false;
                        // Indicate processing state
                        if (this.resultCallback) {
                            this.resultCallback("Processing...", false);
                        }
                    }
                }, this.recordingInterval);
            }
        };

        // Start first recording immediately
        recordChunk();

        // Set up interval for continuous recording
        // Add 500ms gap for processing to complete before next chunk
        this.intervalId = setInterval(recordChunk, this.recordingInterval + 500);
    }

    private async processAudioChunks(): Promise<void> {
        if (this.audioChunks.length === 0) {
            info(`[WHISPER] No audio chunks to process`);
            return;
        }

        try {
            // Combine audio chunks into a single blob
            // Use the actual mime type from the recorder, not a hardcoded one
            const mimeType = this.mediaRecorder?.mimeType || this.getSupportedMimeType();
            const audioBlob = new Blob(this.audioChunks, { type: mimeType });
            info(`[WHISPER] Processing audio blob of size: ${audioBlob.size} bytes, type: ${mimeType}`);
            this.audioChunks = []; // Clear chunks

            // Convert to WAV format using AudioContext
            // This is necessary because the backend expects WAV format
            const wavData = await this.convertToWav(audioBlob);

            if (!wavData || wavData.length === 0) {
                info(`[WHISPER] Failed to convert audio to WAV format`);
                return;
            }

            info(`[WHISPER] Converted to WAV: ${wavData.length} bytes`);
            info(`[WHISPER] Sending audio data to Rust backend`);

            // Send to Rust backend for Whisper processing
            const result = await invoke('whisper_transcribe', {
                audioData: Array.from(wavData),
                model: this.model,
                language: this.language
            }) as string;

            // Debug logging to see what we actually get back
            info(`[WHISPER] Raw transcription result: "${result}" (length: ${result?.length || 0})`);

            if (result && result.trim().length > 0 && this.resultCallback) {
                info(`[WHISPER] Transcription result: ${result}`);
                this.resultCallback(result.trim(), true); // Always final with Whisper
            } else {
                info(`[WHISPER] Empty or null transcription result - no speech detected or language mismatch`);
                // Even with no speech, we should still notify the UI that processing completed
                if (this.resultCallback) {
                    this.resultCallback("", true); // Send empty result to indicate completion
                }
            }
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error processing audio: ${errorMessage}`);
            
            // Report error to UI
            if (this.resultCallback) {
                this.resultCallback(`Transcription error: ${errorMessage}`, true);
            }
        }
    }

    // Convert audio blob to WAV format using AudioContext
    private async convertToWav(audioBlob: Blob): Promise<Uint8Array> {
        try {
            const arrayBuffer = await audioBlob.arrayBuffer();
            // Use default sample rate for decoding, we'll resample to 16kHz after
            const audioContext = new AudioContext();

            // Decode the audio data
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

            // Get mono audio data (average channels if stereo)
            let monoData: Float32Array;
            if (audioBuffer.numberOfChannels > 1) {
                const channel0 = audioBuffer.getChannelData(0);
                const channel1 = audioBuffer.getChannelData(1);
                monoData = new Float32Array(channel0.length);
                for (let i = 0; i < channel0.length; i++) {
                    monoData[i] = (channel0[i] + channel1[i]) / 2;
                }
            } else {
                monoData = audioBuffer.getChannelData(0);
            }

            // Resample to 16kHz if needed
            const sourceSampleRate = audioBuffer.sampleRate;
            if (sourceSampleRate !== 16000) {
                info(`[WHISPER] Resampling from ${sourceSampleRate}Hz to 16000Hz`);
                const ratio = sourceSampleRate / 16000;
                const targetLength = Math.floor(monoData.length / ratio);
                const resampled = new Float32Array(targetLength);
                
                for (let i = 0; i < targetLength; i++) {
                    const srcIndex = Math.floor(i * ratio);
                    if (srcIndex < monoData.length) {
                        resampled[i] = monoData[srcIndex];
                    }
                }
                monoData = resampled;
            }

            // Convert to 16-bit PCM
            const pcmData = new Int16Array(monoData.length);
            for (let i = 0; i < monoData.length; i++) {
                const sample = Math.max(-1, Math.min(1, monoData[i]));
                pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }

            // Create WAV file
            const wavBuffer = this.encodeWav(pcmData, 16000);

            await audioContext.close();

            return new Uint8Array(wavBuffer);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error converting audio to WAV: ${errorMessage}`);
            
            // Report to UI
            if (this.resultCallback) {
                this.resultCallback(`Audio conversion error: ${errorMessage}`, true);
            }
            return new Uint8Array(0);
        }
    }

    // Encode PCM data as WAV file
    private encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);

        // WAV header
        const writeString = (offset: number, str: string) => {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(offset + i, str.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true); // Subchunk1Size
        view.setUint16(20, 1, true); // AudioFormat (PCM)
        view.setUint16(22, 1, true); // NumChannels (mono)
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // ByteRate
        view.setUint16(32, 2, true); // BlockAlign
        view.setUint16(34, 16, true); // BitsPerSample
        writeString(36, 'data');
        view.setUint32(40, samples.length * 2, true);

        // Write samples
        for (let i = 0; i < samples.length; i++) {
            view.setInt16(44 + i * 2, samples[i], true);
        }

        return buffer;
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