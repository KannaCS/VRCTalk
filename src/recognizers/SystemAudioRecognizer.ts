import { Recognizer } from "./recognizer";
import { info, error } from '@tauri-apps/plugin-log';
import { invoke } from '@tauri-apps/api/core';

export class SystemAudioRecognizer extends Recognizer {
    private resultCallback: ((result: string, final: boolean) => void) | null = null;
    
    constructor(lang: string) {
        super(lang);
        info(`[SYSTEM AUDIO] Initialized for system audio output`);
    }

    async start(): Promise<void> {
        this.running = true;
        try {
            await invoke('start_system_audio_capture');
            info("[SYSTEM AUDIO] Started system audio capture");
            
            // Listen for transcription results
            window.addEventListener("system_audio_transcription", (e: any) => {
                const result = e.detail.result;
                const isFinal = e.detail.isFinal;
                if (this.resultCallback) {
                    this.resultCallback(result, isFinal);
                }
            });
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[SYSTEM AUDIO] Error starting: ${errorMessage}`);
            this.running = false;
        }
    }

    stop(): void {
        this.running = false;
        try {
            invoke('stop_system_audio_capture');
            info("[SYSTEM AUDIO] Stopped system audio capture");
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[SYSTEM AUDIO] Error stopping: ${errorMessage}`);
        }
    }

    restart(): void {
        this.stop();
        setTimeout(() => this.start(), 500);
    }

    set_lang(lang: string): void {
        this.language = lang;
        info(`[SYSTEM AUDIO] Language set to: ${lang}`);
    }

    set_microphone(_deviceId: string | null): void {
        // Not applicable for system audio
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
    }
}
