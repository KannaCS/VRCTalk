/**
 * GroqSTT — Speech-to-text recognizer backed by Groq's Whisper API.
 *
 * Hybrid VAD + streaming approach:
 *  - VAD detects speech start/end using RMS threshold
 *  - While speaking, sends a chunk every STREAM_CHUNK_MS for low latency
 *  - On silence end, sends the final remaining audio
 *  - Hallucination filter drops known Whisper artifacts
 */

import { Recognizer } from "./recognizer";
import { info, error, warn, debug } from '@tauri-apps/plugin-log';
import { groqKeyManager } from '../utils/groq_key_manager';

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const SAMPLE_RATE = 16000;
const SCRIPT_PROCESSOR_BUFFER = 4096;
const REQUEST_TIMEOUT_MS = 15000;

// VAD timing
const SILENCE_END_MS = 700;      // trailing silence this long → utterance done
const VAD_POLL_MS = 50;          // VAD loop tick interval
const MIN_UTTERANCE_MS = 300;    // drop utterances shorter than this

// Streaming: while speaking, send a chunk every N ms so the user sees
// results quickly without waiting for end-of-sentence silence.
const STREAM_CHUNK_MS = 4000;

// Default VAD threshold — set above your background noise floor.
// Typical values: quiet room 0.005, noisy room 0.010–0.015.
// Users can adjust in Settings → Mic Sensitivity.
const DEFAULT_VAD_THRESHOLD = 0.010;

export class GroqSTT extends Recognizer {
    private userApiKey: string;
    public vadThreshold: number;
    private selectedMicrophoneId: string | null;

    private audioStream: MediaStream | null = null;
    private audioContext: AudioContext | null = null;
    private sourceNode: MediaStreamAudioSourceNode | null = null;
    private scriptProcessor: ScriptProcessorNode | null = null;

    // Incoming audio frames (drained each VAD tick)
    private allFrames: Float32Array[] = [];
    // Frames accumulated in the current utterance
    private speechFrames: Float32Array[] = [];

    private isSpeaking: boolean = false;
    private silenceFrames: number = 0;
    private utteranceStartTime: number = 0;
    private lastStreamSentTime: number = 0;

    private isStarting: boolean = false;
    private vadTimerId: ReturnType<typeof setInterval> | null = null;
    private resultCallback: ((result: string, final: boolean) => void) | null = null;
    private activeController: AbortController | null = null;

    constructor(
        lang: string,
        userApiKey: string = '',
        vadThreshold: number = DEFAULT_VAD_THRESHOLD,
        microphoneId: string | null = null
    ) {
        super(lang);
        this.userApiKey = userApiKey;
        this.vadThreshold = vadThreshold;
        this.selectedMicrophoneId = microphoneId;
        info(`[GROQSTT] Initialized — lang: ${lang}, vad: ${vadThreshold}`);
    }

    async start(): Promise<void> {
        if (this.isStarting || this.running) {
            debug("[GROQSTT] start() called while already running — ignoring");
            return;
        }
        this.isStarting = true;
        try {
            info("[GROQSTT] Starting Groq STT recognition");

            const testKey = groqKeyManager.getAvailableKey(this.userApiKey || undefined);
            if (!testKey) {
                const msg = "No Groq API key available. Add one in Settings.";
                error(`[GROQSTT] ${msg}`);
                this.resultCallback?.(`Error: ${msg}`, true);
                return;
            }

            const constraints: MediaStreamConstraints = {
                audio: {
                    deviceId: this.selectedMicrophoneId ? { exact: this.selectedMicrophoneId } : undefined,
                    channelCount: 1,
                    sampleRate: SAMPLE_RATE,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                }
            };

            this.audioStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
            this.sourceNode = this.audioContext.createMediaStreamSource(this.audioStream);
            this.scriptProcessor = this.audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1);

            this.allFrames = [];
            this.speechFrames = [];
            this.isSpeaking = false;
            this.silenceFrames = 0;

            this.scriptProcessor.onaudioprocess = (e) => {
                if (!this.running) return;
                this.allFrames.push(new Float32Array(e.inputBuffer.getChannelData(0)));
                e.outputBuffer.getChannelData(0).fill(0);
            };

            this.sourceNode.connect(this.scriptProcessor);
            this.scriptProcessor.connect(this.audioContext.destination);

            this.running = true;
            this.resultCallback?.("Listening...", false);
            this.startVadLoop();
            info("[GROQSTT] Recognition started successfully");
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            error(`[GROQSTT] Error starting: ${msg}`);
            this.running = false;
            this.resultCallback?.(`Error: ${msg}`, true);
        } finally {
            this.isStarting = false;
        }
    }

    stop(): void {
        info("[GROQSTT] Stopping recognition");
        this.running = false;
        this.activeController?.abort();
        this.activeController = null;
        if (this.vadTimerId !== null) { clearInterval(this.vadTimerId); this.vadTimerId = null; }
        if (this.scriptProcessor) { this.scriptProcessor.disconnect(); this.scriptProcessor.onaudioprocess = null; this.scriptProcessor = null; }
        if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
        if (this.audioContext && this.audioContext.state !== 'closed') { this.audioContext.close(); this.audioContext = null; }
        if (this.audioStream) { this.audioStream.getTracks().forEach(t => t.stop()); this.audioStream = null; }
        this.allFrames = [];
        this.speechFrames = [];
        this.isSpeaking = false;
        info("[GROQSTT] Recognition stopped");
    }

    restart(): void {
        info("[GROQSTT] Restarting recognition");
        const wasRunning = this.running;
        this.stop();
        if (wasRunning) setTimeout(() => this.start(), 500);
    }

    set_lang(lang: string): void {
        info(`[GROQSTT] Language → ${lang}`);
        this.language = lang;
        if (this.running) this.restart();
    }

    set_microphone(deviceId: string | null): void {
        info(`[GROQSTT] Microphone → ${deviceId || 'default'}`);
        this.selectedMicrophoneId = deviceId;
        if (this.running) this.restart();
    }

    setApiKey(key: string): void { this.userApiKey = key; }

    setVadThreshold(threshold: number): void {
        this.vadThreshold = threshold;
        info(`[GROQSTT] VAD threshold → ${threshold}`);
    }

    status(): boolean { return this.running; }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
    }

    // ── VAD loop ──────────────────────────────────────────────────────────────

    private startVadLoop(): void {
        this.vadTimerId = setInterval(() => {
            if (!this.running) return;
            this.runVadTick();
        }, VAD_POLL_MS);
    }

    private runVadTick(): void {
        const newFrames = this.allFrames.splice(0);
        if (newFrames.length === 0) return;

        const msPerFrame = (SCRIPT_PROCESSOR_BUFFER / SAMPLE_RATE) * 1000;

        for (const frame of newFrames) {
            const rms = this.frameRms(frame);
            const isSpeechFrame = rms >= this.vadThreshold;

            if (!this.isSpeaking) {
                if (isSpeechFrame) {
                    this.isSpeaking = true;
                    this.silenceFrames = 0;
                    this.utteranceStartTime = Date.now();
                    this.lastStreamSentTime = Date.now();
                    this.speechFrames = [frame];
                    debug(`[GROQSTT] Speech started (rms=${rms.toFixed(4)})`);
                }
            } else {
                this.speechFrames.push(frame);

                if (isSpeechFrame) {
                    this.silenceFrames = 0;
                } else {
                    this.silenceFrames++;
                }

                const silenceDuration = this.silenceFrames * msPerFrame;
                const utteranceDuration = Date.now() - this.utteranceStartTime;
                const timeSinceLastSend = Date.now() - this.lastStreamSentTime;

                // Stream chunk: send every STREAM_CHUNK_MS while speaking
                // so the user sees quick results on long sentences
                if (timeSinceLastSend >= STREAM_CHUNK_MS && this.speechFrames.length > 0) {
                    info(`[GROQSTT] Streaming chunk after ${utteranceDuration}ms`);
                    const framesToSend = [...this.speechFrames];
                    this.speechFrames = [];
                    this.lastStreamSentTime = Date.now();
                    this.processUtterance(framesToSend, false);
                }
                // End of utterance: trailing silence detected
                else if (silenceDuration >= SILENCE_END_MS) {
                    info(`[GROQSTT] Utterance ended (silence, ${utteranceDuration}ms)`);
                    this.isSpeaking = false;
                    this.silenceFrames = 0;

                    if (utteranceDuration < MIN_UTTERANCE_MS) {
                        debug(`[GROQSTT] Dropping short utterance (${utteranceDuration}ms)`);
                        this.speechFrames = [];
                        return;
                    }

                    // Trim trailing silent frames
                    const silentFrameCount = Math.ceil(SILENCE_END_MS / msPerFrame);
                    const framesToSend = this.speechFrames.slice(0, Math.max(1, this.speechFrames.length - silentFrameCount));
                    this.speechFrames = [];
                    this.processUtterance(framesToSend, true);
                }
            }
        }
    }

    // ── Utterance processing ──────────────────────────────────────────────────

    private async processUtterance(frames: Float32Array[], isFinalChunk: boolean): Promise<void> {
        const totalLen = frames.reduce((n, f) => n + f.length, 0);
        if (totalLen === 0) return;

        const combined = new Float32Array(totalLen);
        let offset = 0;
        for (const f of frames) { combined.set(f, offset); offset += f.length; }

        // Energy sanity check
        const rms = this.frameRms(combined);
        if (rms < this.vadThreshold * 0.7) {
            debug(`[GROQSTT] Dropping low-energy utterance (rms=${rms.toFixed(5)})`);
            return;
        }

        const pcm = new Int16Array(totalLen);
        for (let i = 0; i < totalLen; i++) {
            const s = Math.max(-1, Math.min(1, combined[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const wavBlob = new Blob([this.encodeWav(pcm, SAMPLE_RATE)], { type: "audio/wav" });
        this.resultCallback?.("Processing...", false);

        const text = await this.transcribe(wavBlob);

        if (!text || this.isHallucination(text)) {
            if (text) info(`[GROQSTT] Filtered hallucination: "${text}"`);
            this.resultCallback?.("Listening...", false);
            return;
        }

        info(`[GROQSTT] Transcription: "${text}"`);
        // Stream chunks are interim (false), final silence-triggered chunks are final (true)
        this.resultCallback?.(text.trim(), isFinalChunk);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private frameRms(frame: Float32Array): number {
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
        return Math.sqrt(sum / frame.length);
    }

    private isHallucination(text: string): boolean {
        const t = text.trim();
        if (/^[.,!?;:\-–—…]+$/.test(t)) return true;
        const known = [
            "thank you.", "thanks.", "thank you", "thanks",
            "terima kasih.", "terima kasih",
            "you", ".", "..", "...", "okay.", "ok.", "okay", "ok",
            "hmm.", "hmm", "um.", "um", "uh.", "uh",
            "♪", "♫", "[music]", "[applause]", "[silence]",
            "subtitles by", "subtitle", "transcribed by",
        ];
        if (known.includes(t.toLowerCase())) return true;
        if (t.length <= 2 && !/[a-zA-Z]/.test(t)) return true;
        return false;
    }

    // ── Groq API call ─────────────────────────────────────────────────────────

    private async transcribe(wav: Blob): Promise<string | null> {
        const apiKey = groqKeyManager.getAvailableKey(this.userApiKey || undefined);
        if (!apiKey) { warn("[GROQSTT] No API key available"); return null; }

        const langCode = this.language.includes('-') ? this.language.split('-')[0] : this.language;

        const form = new FormData();
        form.append("file", wav, "audio.wav");
        form.append("model", GROQ_MODEL);
        form.append("language", langCode);
        form.append("response_format", "text");
        form.append("temperature", "0");

        this.activeController = new AbortController();
        const timeoutId = setTimeout(() => this.activeController?.abort(), REQUEST_TIMEOUT_MS);

        try {
            const response = await fetch(GROQ_TRANSCRIPTION_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}` },
                body: form,
                signal: this.activeController.signal,
            });
            clearTimeout(timeoutId);
            this.activeController = null;

            if (response.status === 429) {
                const retryAfter = parseInt(response.headers.get("retry-after") || "60", 10);
                groqKeyManager.markKeyRateLimited(apiKey, retryAfter);
                warn(`[GROQSTT] Rate limited — retry in ${retryAfter}s`);
                return null;
            }
            if (!response.ok) {
                error(`[GROQSTT] API error ${response.status}: ${await response.text().catch(() => "")}`);
                groqKeyManager.markKeyFailed(apiKey);
                return null;
            }
            groqKeyManager.markKeySuccess(apiKey);
            return (await response.text()).trim();
        } catch (err: unknown) {
            clearTimeout(timeoutId);
            this.activeController = null;
            if (err instanceof Error && err.name === "AbortError") {
                warn("[GROQSTT] Request aborted");
            } else {
                error(`[GROQSTT] Fetch error: ${err instanceof Error ? err.message : String(err)}`);
                groqKeyManager.markKeyFailed(apiKey);
            }
            return null;
        }
    }

    // ── WAV encoder ───────────────────────────────────────────────────────────

    private encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);
        const w = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
        w(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
        w(8, "WAVE"); w(12, "fmt ");
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        w(36, "data"); view.setUint32(40, samples.length * 2, true);
        for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
        return buffer;
    }
}
