import { Recognizer } from "./recognizer";
import { info, error } from '@tauri-apps/plugin-log';
import { invoke } from '@tauri-apps/api/core';

export class Whisper extends Recognizer {
    public model: string;
    public vadThreshold: number;
    private selectedMicrophoneId: string | null = null;
    private audioStream: MediaStream | null = null;
    private audioContext: AudioContext | null = null;
    private scriptProcessor: ScriptProcessorNode | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private isRecording: boolean = false;
    private audioData: Float32Array[] = [];
    private resultCallback: ((result: string, final: boolean) => void) | null = null;
    private recordingInterval: number = 3000; // 3s chunks
    private intervalId: NodeJS.Timeout | null = null;
    private isStarting: boolean = false;

    constructor(lang: string, model: string, vadThreshold: number = 0.005, microphoneId: string | null = null) {
        super(lang);
        this.model = model;
        this.vadThreshold = vadThreshold;
        this.selectedMicrophoneId = microphoneId;

        info(`[WHISPER] Initialized with model: ${model}, language: ${lang}, vadThreshold: ${vadThreshold}`);
    }

    async start(): Promise<void> {
        if (this.isStarting || this.running) return;
        this.isStarting = true;

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
                this.isStarting = false;
                return;
            }

            // Get microphone access
            const constraints: MediaStreamConstraints = {
                audio: {
                    deviceId: this.selectedMicrophoneId ? { exact: this.selectedMicrophoneId } : undefined,
                    channelCount: 1, // Prefer mono audio
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            };

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Set up AudioContext for raw PCM capture at exactly 16kHz
            this.audioContext = new AudioContext({ sampleRate: 16000 });
            this.sourceNode = this.audioContext.createMediaStreamSource(this.audioStream);
            this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);

            this.audioData = [];

            this.scriptProcessor.onaudioprocess = (e) => {
                if (!this.running) return;
                const inputData = e.inputBuffer.getChannelData(0);
                this.audioData.push(new Float32Array(inputData));
                
                // Mute output to prevent echo
                e.outputBuffer.getChannelData(0).fill(0);
            };

            this.sourceNode.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);

            this.running = true;
            this.isRecording = true;

            if (this.resultCallback) {
                this.resultCallback("Listening...", false);
            }

            this.startProcessingLoop();

            info("[WHISPER] Recognition started successfully");
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error starting recognition: ${errorMessage}`);
            this.running = false;
            
            // Report error to UI
            if (this.resultCallback) {
                this.resultCallback(`Error starting Whisper: ${errorMessage}`, true);
            }
        } finally {
            this.isStarting = false;
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

        if (this.scriptProcessor) {
            this.scriptProcessor.disconnect();
            this.scriptProcessor.onaudioprocess = null;
            this.scriptProcessor = null;
        }

        if (this.sourceNode) {
            this.sourceNode.disconnect();
            this.sourceNode = null;
        }

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
            this.audioContext = null;
        }

        if (this.audioStream) {
            const tracks = this.audioStream.getTracks();
            tracks.forEach(track => track.stop());
            this.audioStream = null;
        }

        this.audioData = [];
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

    setVadThreshold(threshold: number): void {
        info(`[WHISPER] Setting VAD threshold to: ${threshold}`);
        this.vadThreshold = threshold;
    }

    private startProcessingLoop(): void {
        this.intervalId = setInterval(() => {
            if (!this.running) return;
            this.processAudioData();
        }, this.recordingInterval);
    }

    private async processAudioData(): Promise<void> {
        if (this.audioData.length === 0) return;

        // Extract current data and clear for next chunk seamlessly
        const currentData = this.audioData;
        this.audioData = [];

        try {
            // Calculate total length
            const totalLength = currentData.reduce((acc, val) => acc + val.length, 0);
            const combinedData = new Float32Array(totalLength);
            let offset = 0;
            for (const arr of currentData) {
                combinedData.set(arr, offset);
                offset += arr.length;
            }

            // Convert to 16-bit PCM
            const pcmData = new Int16Array(totalLength);
            for (let i = 0; i < totalLength; i++) {
                const sample = Math.max(-1, Math.min(1, combinedData[i]));
                pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
            }

            // Create WAV file buffer
            const wavBuffer = this.encodeWav(pcmData, 16000);
            const wavData = new Uint8Array(wavBuffer);

            info(`[WHISPER] Processing raw PCM chunk: ${wavData.length} bytes`);

            if (this.resultCallback) {
                this.resultCallback("Processing...", false);
            }

            // Send to Rust backend for Whisper processing
            const result = await invoke('whisper_transcribe', {
                audioData: Array.from(wavData),
                model: this.model,
                language: this.language,
                vadThreshold: this.vadThreshold
            }) as string;

            info(`[WHISPER] Raw transcription result: "${result}" (length: ${result?.length || 0})`);

            if (result && result.trim().length > 0 && this.resultCallback) {
                info(`[WHISPER] Transcription result: ${result}`);
                this.resultCallback(result.trim(), true); // Always final with Whisper
            } else {
                info(`[WHISPER] Empty or null transcription result - no speech detected or language mismatch`);
                if (this.resultCallback) {
                    this.resultCallback("", true); // Send empty result to indicate completion
                }
            }
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WHISPER] Error processing audio: ${errorMessage}`);
            
            if (this.resultCallback) {
                this.resultCallback("Listening...", false);
            }
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