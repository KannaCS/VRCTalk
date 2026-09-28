import { Recognizer } from "./recognizer";
import { info, error, debug } from '@tauri-apps/plugin-log';

// ─── Extended type declarations for modern Web Speech API ────────────────────
// Chrome/Edge added processLocally, SpeechRecognition.available(), and
// SpeechRecognition.install() in 2025/2026.  Tauri's bundled WebView2 on
// Windows is affected by a known Edge bug (Edge ≥ 134) where the cloud speech
// backend intermittently returns "network" errors.  On-device processing
// bypasses the cloud entirely and fixes the issue.
declare global {
    interface Window {
        webkitSpeechRecognition: any;
        SpeechRecognition: any;
    }
}

type OnDeviceAvailability = "available" | "downloadable" | "downloading" | "unavailable";

interface SpeechRecognitionAvailableOptions {
    langs: string[];
    processLocally?: boolean;
    quality?: "command" | "dictation" | "conversation";
}

interface SpeechRecognitionConstructor {
    new(): any;
    available?: (options: SpeechRecognitionAvailableOptions) => Promise<OnDeviceAvailability>;
    install?: (options: SpeechRecognitionAvailableOptions) => Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────────────────────

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
    // Prevents handleOnEnd from scheduling a competing restart while the
    // health check is already performing its own stop → start cycle.
    private isHealthChecking: boolean = false;
    // Track consecutive network errors to prevent infinite restart loops
    private consecutiveNetworkErrors: number = 0;
    private maxConsecutiveNetworkErrors: number = 3;

    // On-device processing state.
    // We attempt processLocally=true first (avoids Edge/WebView2 cloud bug).
    // Falls back to cloud (processLocally=false) when on-device is unavailable.
    private processLocally: boolean = false;
    private processLocallyChecked: boolean = false;
    private onDeviceInstallInProgress: boolean = false;

    // Tracks whether the underlying SpeechRecognition object is currently
    // active (between start() and the next onend/onerror).  Used to suppress
    // duplicate start() calls that arrive from concurrent callers.
    private _recognitionActive: boolean = false;

    constructor(lang: string, microphoneId: string | null = null) {
        super(lang);
        this.selectedMicrophoneId = microphoneId;
        this.lang = lang;
        this.initRecognition();
    }

    // ── On-device availability check ─────────────────────────────────────────

    /**
     * Checks whether the current language supports on-device (local) speech
     * recognition.  If available, sets processLocally=true so future
     * recognition instances bypass the cloud backend that is broken in
     * Edge ≥ 134 / WebView2.  Resolves immediately when not supported by the
     * browser or when the check was already performed.
     */
    private async checkOnDeviceAvailability(): Promise<void> {
        if (this.processLocallyChecked) return;
        this.processLocallyChecked = true;

        const SR: SpeechRecognitionConstructor | undefined =
            window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SR || typeof SR.available !== "function") {
            info("[WEBSPEECH] On-device speech recognition API not available in this browser (older WebView2/Chrome)");
            this.processLocally = false;
            return;
        }

        try {
            const result = await SR.available({
                langs: [this.lang],
                processLocally: true,
                quality: "dictation",
            });

            info(`[WEBSPEECH] On-device availability for "${this.lang}": ${result}`);

            if (result === "available") {
                info("[WEBSPEECH] On-device recognition available — enabling processLocally to avoid Edge/WebView2 cloud bug");
                this.processLocally = true;
            } else if (result === "downloadable" || result === "downloading") {
                // Language pack exists but needs downloading.  Start the
                // download in the background; use cloud for now.
                info(`[WEBSPEECH] On-device language pack ${result} for "${this.lang}" — triggering download`);
                this.processLocally = false;
                this.triggerLanguagePackInstall();
            } else {
                // "unavailable" — no on-device support, must use cloud
                info(`[WEBSPEECH] On-device recognition unavailable for "${this.lang}" — falling back to cloud`);
                this.processLocally = false;
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error checking on-device availability: ${msg}`);
            this.processLocally = false;
        }

        // Recreate the recognition object now that we know the preferred mode
        this.initRecognition();
    }

    /**
     * Silently attempts to download the on-device language pack.  When done,
     * re-enables processLocally and reinitialises the recognition object so
     * subsequent sessions use the local engine.
     */
    private triggerLanguagePackInstall(): void {
        if (this.onDeviceInstallInProgress) return;

        const SR: SpeechRecognitionConstructor | undefined =
            window.SpeechRecognition || window.webkitSpeechRecognition;

        if (!SR || typeof SR.install !== "function") return;

        this.onDeviceInstallInProgress = true;
        info(`[WEBSPEECH] Starting background download of on-device language pack for "${this.lang}"`);

        SR.install({ langs: [this.lang], processLocally: true, quality: "dictation" })
            .then((success: boolean) => {
                this.onDeviceInstallInProgress = false;
                if (success) {
                    info(`[WEBSPEECH] On-device language pack for "${this.lang}" installed — switching to local processing`);
                    this.processLocally = true;
                    // Reinitialize so the next session uses on-device
                    this.processLocallyChecked = true;
                    this.initRecognition();
                    // If we are currently running, restart to pick up the new mode
                    if (this.running) {
                        this.restart();
                    }
                } else {
                    error(`[WEBSPEECH] On-device language pack install failed for "${this.lang}"`);
                }
            })
            .catch((err: unknown) => {
                this.onDeviceInstallInProgress = false;
                const msg = err instanceof Error ? err.message : String(err);
                error(`[WEBSPEECH] Error installing on-device language pack: ${msg}`);
            });
    }

    // ── Recognition object lifecycle ─────────────────────────────────────────

    private initRecognition(): void {
        info(`[WEBSPEECH] Initializing recognition — lang: ${this.lang}, processLocally: ${this.processLocally}`);
        const SpeechRecognition: any = window.SpeechRecognition || window.webkitSpeechRecognition;

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

            // Use on-device processing when available to avoid the
            // Edge ≥ 134 / WebView2 cloud speech backend bug.
            if ("processLocally" in this.recognition) {
                this.recognition.processLocally = this.processLocally;
            }

            // Set up standard event handlers
            this.recognition.onend = () => this.handleOnEnd();
            this.recognition.onnomatch = () => this.handleOnNoMatch();
            this.recognition.onerror = (e: { error?: string }) => this.handleOnError(e);
            this.recognition.onstart = () => this.handleOnStart();

            // Re-attach the result callback if one was previously set
            if (this.resultCallback) {
                this.recognition.onresult = this.handleOnResult.bind(this);
            }

            // Reset reconnect attempts when successfully initialized
            this.reconnectAttempts = 0;
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error initializing speech recognition: ${errorMessage}`);
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    private handleOnStart(): void {
        info(`[WEBSPEECH] Recognition started successfully (processLocally=${this.processLocally})`);
        this.lastActivityTime = Date.now();
        this.reconnectAttempts = 0;
        this._recognitionActive = true;
        // NOTE: do NOT reset consecutiveNetworkErrors here.
        // The browser fires onstart even when the cloud backend is broken —
        // it fires immediately before the network error.  Resetting here
        // prevents the error counter from ever accumulating past 1.
        // The counter is only cleared in handleOnResult (genuine transcription)
        // and stop() (intentional stop).
    }

    private handleOnEnd(): void {
        this._recognitionActive = false;
        const shouldBeRunning = this.running;

        if (shouldBeRunning && !this.isHealthChecking) {
            info("[WEBSPEECH] Recognition ended unexpectedly. Restarting...");

            const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts), 10000);
            this.reconnectAttempts++;

            if (this.reconnectAttempts <= this.maxReconnectAttempts) {
                info(`[WEBSPEECH] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

                setTimeout(() => {
                    try {
                        this.recognition.start();
                        this._recognitionActive = true;
                        info("[WEBSPEECH] Recognition restarted successfully");
                    } catch (err: unknown) {
                        const errorMessage = err instanceof Error ? err.message : String(err);
                        if (errorMessage.includes("already started")) {
                            info("[WEBSPEECH] Restart skipped — recognition already active");
                            this._recognitionActive = true;
                            return;
                        }
                        error(`[WEBSPEECH] Failed to restart recognition: ${errorMessage}`);

                        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                            info("[WEBSPEECH] Max reconnect attempts reached, reinitializing recognition");
                            this.initRecognition();

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
        if (this.running) {
            info("[WEBSPEECH] No match. Restarting...");
            setTimeout(() => {
                try {
                    this.recognition.start();
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Failed to restart recognition after no match: ${errorMessage}`);
                    this.running = false;
                }
            }, 500);
        }
    }

    private handleOnError(e: { error?: string }): void {
        if (e.error && e.error.trim().length !== 0) {
            error("[WEBSPEECH] Error: " + e.error);

            if (e.error === 'no-speech') {
                info("[WEBSPEECH] No speech detected, this is normal");
                return;
            } else if (e.error === 'network') {
                this.consecutiveNetworkErrors++;
                error(`[WEBSPEECH] Network error occurred (consecutive: ${this.consecutiveNetworkErrors}/${this.maxConsecutiveNetworkErrors}, processLocally=${this.processLocally})`);

                // Network errors in Edge ≥ 134 / WebView2 are caused by a broken
                // cloud speech backend.  When we've accumulated enough errors,
                // try switching to on-device processing as a self-healing strategy.
                if (!this.processLocally && this.consecutiveNetworkErrors >= this.maxConsecutiveNetworkErrors) {
                    error("[WEBSPEECH] Too many cloud network errors — attempting switch to on-device recognition");
                    this.processLocallyChecked = false; // force a fresh availability check
                    this.consecutiveNetworkErrors = 0;

                    // Pause running so handleOnEnd does not schedule a competing
                    // reconnect while we await the async availability check.
                    this.running = false;
                    this.stopHealthCheck();

                    // Re-run availability check, then decide what to do:
                    // - on-device available → restart with processLocally=true
                    // - on-device unavailable → hard stop, cloud is broken and
                    //   there is no fallback; further retries would loop forever
                    this.checkOnDeviceAvailability().then(() => {
                        if (this.processLocally) {
                            // Switched to on-device successfully — restart
                            this.running = true;
                            this.restart();
                        } else {
                            // On-device is unavailable too: the Web Speech API
                            // cloud backend is broken (Edge ≥ 134 / WebView2 bug)
                            // and there is nothing more we can do automatically.
                            error("[WEBSPEECH] Cloud backend broken and on-device unavailable — stopping. Switch to Whisper or check internet/Edge settings.");
                            if (this.resultCallback) {
                                this.resultCallback("[ERROR: Web Speech API unavailable (Edge/WebView2 cloud bug). Please switch to Whisper in Settings, or check your internet connection.]", true);
                            }
                        }
                    });
                    return;
                }

                // Already using on-device and still getting network errors — unusual,
                // but treat as a hard stop to avoid infinite loops.
                if (this.processLocally && this.consecutiveNetworkErrors >= this.maxConsecutiveNetworkErrors) {
                    error("[WEBSPEECH] Too many consecutive errors even with on-device recognition. Stopping.");
                    this.running = false;
                    this.stopHealthCheck();

                    if (this.resultCallback) {
                        this.resultCallback("[ERROR: Speech recognition unavailable. Check microphone settings.]", true);
                    }
                    return;
                }

                const delay = Math.min(2000 * Math.pow(2, this.consecutiveNetworkErrors - 1), 10000);
                if (this.running) {
                    info(`[WEBSPEECH] Will retry in ${delay}ms...`);
                    setTimeout(() => {
                        if (this.running) {
                            this.restart();
                        }
                    }, delay);
                }
                return;
            } else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
                error("[WEBSPEECH] Speech recognition permission denied");
                this.running = false;
                this.stopHealthCheck();

                if (this.resultCallback) {
                    this.resultCallback("[ERROR: Microphone permission denied. Please allow microphone access.]", true);
                }
                return;
            } else if (e.error === 'language-not-supported') {
                // Fired when processLocally=true but the language pack is missing.
                // Trigger a pack install and fall back to cloud for now.
                error(`[WEBSPEECH] Language pack not available on-device for "${this.lang}" — falling back to cloud and triggering install`);
                this.processLocally = false;
                this.initRecognition();
                this.triggerLanguagePackInstall();

                if (this.running) {
                    setTimeout(() => {
                        try { this.recognition.start(); } catch (_) { /* ignore */ }
                    }, 500);
                }
                return;
            } else if (e.error === 'aborted') {
                info("[WEBSPEECH] Recognition aborted, this is usually normal during restart");
                return;
            }
        }

        if (this.running) {
            info("[WEBSPEECH] Recovering from error. Restarting...");
            setTimeout(() => {
                try {
                    this.recognition.start();
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Failed to restart recognition after error: ${errorMessage}`);
                    this.running = false;
                }
            }, 500);
        }
    }

    // ── Public interface ──────────────────────────────────────────────────────

    async start(): Promise<void> {
        // Guard: if the underlying recognition object is already active, skip
        // silently.  Multiple callers (VRCTalk useEffects + delayed starts) can
        // race to call start(); duplicate calls produce "already started" errors
        // that confuse the error-counting logic.
        if (this.running && this._recognitionActive) {
            info("[WEBSPEECH] start() called while already running — ignoring duplicate");
            return;
        }

        this.running = true;
        this.lastActivityTime = Date.now();
        this.reconnectAttempts = 0;
        // NOTE: do NOT reset consecutiveNetworkErrors here — it must survive
        // across restart() calls so that persistent network failures accumulate
        // and trigger the on-device fallback.  It is only cleared in
        // handleOnStart() (successful cloud/on-device connection) and stop().

        // Perform on-device check on first start (non-blocking — the
        // check reinitialises the recognition object when done, and if
        // we're already starting we just start with whatever mode is
        // current and the next restart will pick up the new setting).
        if (!this.processLocallyChecked) {
            // Fire-and-forget; initRecognition() at the end of the check
            // will update the object before the first restart.
            this.checkOnDeviceAvailability();
        }

        this.startHealthCheck();

        try {
            this.recognition.start();
            this._recognitionActive = true;
            info(`[WEBSPEECH] Recognition started (processLocally=${this.processLocally})`);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            // "already started" is a benign race — don't treat it as a real failure
            if (errorMessage.includes("already started")) {
                info("[WEBSPEECH] start() skipped — recognition already active");
                this._recognitionActive = true;
            } else {
                error(`[WEBSPEECH] Error starting recognition: ${errorMessage}`);
                this.running = false;
                this._recognitionActive = false;
            }
        }
    }

    stop(): void {
        this.running = false;
        this._recognitionActive = false;
        this.consecutiveNetworkErrors = 0;
        this.stopHealthCheck();

        try {
            this.recognition.stop();

            if (this.audioStream) {
                this.audioStream.getTracks().forEach(track => track.stop());
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
        const currentMicId = this.selectedMicrophoneId;

        try {
            this.running = false;
            this._recognitionActive = false;
            this.reconnectAttempts = 0;
            // Do NOT reset consecutiveNetworkErrors here — errors must
            // accumulate across restart() calls to trigger the on-device fallback.

            this.stopHealthCheck();

            try {
                this.recognition.stop();
            } catch (_) { /* ignore */ }

            if (this.audioStream) {
                this.audioStream.getTracks().forEach(track => {
                    track.stop();
                    info(`[WEBSPEECH] Stopped audio track: ${track.label || track.id}`);
                });
                this.audioStream = null;
            }

            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }

            this.selectedMicrophoneId = null;

            setTimeout(() => {
                this.selectedMicrophoneId = currentMicId;
                info("[WEBSPEECH] Reinitializing recognition object during restart");
                this.initRecognition();

                if (wasRunning) {
                    this.running = true;
                    setTimeout(() => {
                        try {
                            info("[WEBSPEECH] Starting recognition after restart");
                            this.start();
                        } catch (err: unknown) {
                            const errorMessage = err instanceof Error ? err.message : String(err);
                            error(`[WEBSPEECH] Error starting recognition after restart: ${errorMessage}`);
                            this.running = false;
                        }
                    }, 300);
                }
            }, 200);
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            error(`[WEBSPEECH] Error during restart: ${errorMessage}`);

            this.reconnectAttempts = 0;
            this.selectedMicrophoneId = currentMicId;
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

            if (this.recognition.lang === lang) {
                info(`[WEBSPEECH] Language is already set to ${lang}, no change needed`);
                return;
            }

            this.recognition.lang = lang;
            this.lang = lang;

            // Reset on-device check state so the new language is probed
            this.processLocallyChecked = false;
            this.processLocally = false;

            const wasRunning = this.running;
            info(`[WEBSPEECH] Language change — was running: ${wasRunning}`);

            try {
                this.stop();
            } catch (err: unknown) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                error(`[WEBSPEECH] Error stopping recognition during language change: ${errorMessage}`);
            }

            this.reconnectAttempts = 0;

            setTimeout(() => {
                try {
                    info("[WEBSPEECH] Creating new recognition instance for language change");

                    if (this.audioStream) {
                        this.audioStream.getTracks().forEach(track => track.stop());
                        this.audioStream = null;
                    }

                    if (this.audioContext) {
                        this.audioContext.close();
                        this.audioContext = null;
                    }

                    this.initRecognition();

                    if (wasRunning) {
                        info("[WEBSPEECH] Restarting recognition with new language");
                        this.running = true;
                        // checkOnDeviceAvailability will be called inside start()
                        setTimeout(() => { this.start(); }, 200);
                    } else {
                        info("[WEBSPEECH] Recognition was not running, language updated");
                    }
                } catch (err: unknown) {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Error recreating recognition instance: ${errorMessage}`);

                    try {
                        if (wasRunning) {
                            info("[WEBSPEECH] Attempting final restart after error");
                            this.running = true;
                            setTimeout(() => { this.start(); }, 500);
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
        this.reconnectAttempts = 0;

        if (deviceId) {
            navigator.mediaDevices.enumerateDevices()
                .then(devices => {
                    const audioInputs = devices.filter(device => device.kind === "audioinput");
                    const selectedDevice = audioInputs.find(device => device.deviceId === deviceId);

                    if (selectedDevice) {
                        info(`[WEBSPEECH] Found selected microphone: ${selectedDevice.label || deviceId}`);
                        this.restart();
                    } else {
                        error(`[WEBSPEECH] Error: Selected microphone ${deviceId} not found in available devices`);
                        const availableMics = audioInputs.map(d => `${d.label || 'Unnamed'} (${d.deviceId.substring(0, 8)}...)`).join(', ');
                        error(`[WEBSPEECH] Available microphones: ${availableMics || 'None'}`);

                        info(`[WEBSPEECH] Falling back to default microphone`);
                        this.selectedMicrophoneId = null;
                        this.restart();
                    }
                })
                .catch(err => {
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Error accessing media devices when changing microphone: ${errorMessage}`);
                    info(`[WEBSPEECH] Falling back to default microphone due to error`);
                    this.selectedMicrophoneId = null;
                    this.restart();
                });
        } else {
            info(`[WEBSPEECH] Using default system microphone`);
            this.restart();
        }
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
        this.recognition.onresult = this.handleOnResult.bind(this);
    }

    private handleOnResult(event: any): void {
        if (!this.resultCallback) return;

        if (event.results.length > 0) {
            this.lastActivityTime = Date.now();
            this.reconnectAttempts = 0;
            // Receiving actual transcription is proof the backend is working
            this.consecutiveNetworkErrors = 0;

            let interimTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const result = event.results[i];
                const transcript = result[0].transcript.trim();

                if (result.isFinal) {
                    if (transcript.length > 0) {
                        this.resultCallback(transcript, true);
                    }
                } else {
                    interimTranscript += transcript;
                }
            }

            if (event.results[event.results.length - 1].isFinal === false) {
                this.resultCallback(interimTranscript.trim(), false);
            }
        }
    }

    // ── Health check ──────────────────────────────────────────────────────────

    private startHealthCheck(): void {
        this.stopHealthCheck();

        this.healthCheckInterval = setInterval(() => {
            if (!this.running) {
                this.stopHealthCheck();
                return;
            }

            const timeSinceLastActivity = Date.now() - this.lastActivityTime;

            if (timeSinceLastActivity > this.maxIdleTime) {
                info(`[WEBSPEECH] Health check: Recognition idle for ${timeSinceLastActivity}ms. Restarting...`);
                this.lastActivityTime = Date.now();

                this.isHealthChecking = true;

                try {
                    this.recognition.stop();
                    setTimeout(() => {
                        this.isHealthChecking = false;
                        if (this.running) {
                            try {
                                this.recognition.start();
                                info("[WEBSPEECH] Health check: Recognition restarted successfully");
                            } catch (err: unknown) {
                                const errorMessage = err instanceof Error ? err.message : String(err);
                                error(`[WEBSPEECH] Health check: Failed to restart: ${errorMessage}`);

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
                    this.isHealthChecking = false;
                    const errorMessage = err instanceof Error ? err.message : String(err);
                    error(`[WEBSPEECH] Health check: Error during restart: ${errorMessage}`);
                }
            }
        }, 10000);

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
