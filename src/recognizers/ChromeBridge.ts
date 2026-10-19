/**
 * ChromeBridge — Web Speech API via a real Chrome/Edge instance.
 *
 * Workaround for Tauri/WebView2 not shipping the browser-vendor speech
 * recognition service.  Strategy:
 *
 *  1. Write the bridge HTML to a temp file (via Tauri fs plugin)
 *  2. Find Chrome or Edge on the system (via Tauri shell)
 *  3. Spawn it with --app=file:///... (minimal window, auto-hidden)
 *  4. Bridge page runs webkitSpeechRecognition and POSTs results to
 *     a local HTTP server started in the Tauri Rust backend (port 19421)
 *  5. Rust backend emits Tauri events → this class receives them
 *
 * Reference: "Vxtron hack" pattern used in Electron apps.
 */

import { Recognizer } from "./recognizer";
import { info, error, warn } from '@tauri-apps/plugin-log';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { Command } from '@tauri-apps/plugin-shell';

// Chrome/Edge candidate paths on Windows
const CHROME_PATHS = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${typeof process !== 'undefined' ? process.env.LOCALAPPDATA || '' : ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

interface BridgeResult {
    transcript: string;
    isFinal: boolean;
}

export class ChromeBridge extends Recognizer {
    private resultCallback: ((result: string, final: boolean) => void) | null = null;
    private unlistenResult: UnlistenFn | null = null;
    private unlistenStatus: UnlistenFn | null = null;
    private unlistenError: UnlistenFn | null = null;
    private chromeProcess: any = null;

    constructor(lang: string) {
        super(lang);
        info(`[CHROMEBRIDGE] Initialized — lang: ${lang}`);
    }

    async start(): Promise<void> {
        if (this.running) {
            info("[CHROMEBRIDGE] Already running");
            return;
        }

        try {
            info("[CHROMEBRIDGE] Starting Chrome bridge");

            // 1. Get bridge HTML from Rust (embedded at compile time)
            const html: string = await invoke('get_bridge_html_path');

            // Write to temp location accessible as a file:// URL
            const fileName = 'vrctalk_bridge.html';
            await writeTextFile(fileName, html, { baseDir: BaseDirectory.Temp });

            // Get the temp dir path for the file:// URL
            const tempPath = await this.getTempFilePath(fileName);
            info(`[CHROMEBRIDGE] Bridge HTML written to: ${tempPath}`);

            // 2. Start the Rust HTTP server that receives results
            await invoke('start_chrome_bridge', { lang: this.language });

            // 3. Listen for events from Rust
            this.unlistenResult = await listen<BridgeResult>('chrome-bridge-result', (event) => {
                const { transcript, isFinal } = event.payload;
                if (this.resultCallback && transcript.trim().length > 0) {
                    this.resultCallback(transcript.trim(), isFinal);
                }
            });

            this.unlistenStatus = await listen<string>('chrome-bridge-status', () => {
                info("[CHROMEBRIDGE] Chrome bridge connected and listening");
            });

            this.unlistenError = await listen<string>('chrome-bridge-error', (event) => {
                warn(`[CHROMEBRIDGE] Bridge error: ${event.payload}`);
            });

            // 4. Find and spawn Chrome/Edge
            const chromePath = await this.findChrome();
            if (!chromePath) {
                throw new Error('Chrome or Edge not found. Please install Google Chrome.');
            }

            info(`[CHROMEBRIDGE] Spawning Chrome: ${chromePath}`);

            // --app makes it a minimal window; --window-size=1,1 makes it tiny
            // User will briefly see a small window — this is expected
            const fileUrl = `file:///${tempPath.replace(/\\/g, '/')}?lang=${encodeURIComponent(this.language)}`;

            this.chromeProcess = Command.create('chrome-bridge', [
                chromePath,
                `--app=${fileUrl}`,
                '--window-size=200,80',
                '--window-position=0,0',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-extensions',
                '--disable-popup-blocking',
                '--autoplay-policy=no-user-gesture-required',
            ]);

            await this.chromeProcess.spawn();

            this.running = true;
            info("[CHROMEBRIDGE] Chrome bridge started successfully");

        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            error(`[CHROMEBRIDGE] Failed to start: ${msg}`);
            this.running = false;
            if (this.resultCallback) {
                this.resultCallback(`Error: ${msg}`, true);
            }
        }
    }

    stop(): void {
        info("[CHROMEBRIDGE] Stopping");
        this.running = false;

        if (this.chromeProcess) {
            try { this.chromeProcess.kill(); } catch (_) {}
            this.chromeProcess = null;
        }

        this.unlistenResult?.();
        this.unlistenStatus?.();
        this.unlistenError?.();
        this.unlistenResult = null;
        this.unlistenStatus = null;
        this.unlistenError = null;
    }

    restart(): void {
        const wasRunning = this.running;
        this.stop();
        if (wasRunning) setTimeout(() => this.start(), 500);
    }

    set_lang(lang: string): void {
        info(`[CHROMEBRIDGE] Language → ${lang}`);
        this.language = lang;
        // Update the Rust config so Chrome bridge picks up new lang on next poll
        invoke('update_bridge_lang', { lang }).catch(() => {});
    }

    set_microphone(_deviceId: string | null): void {
        // Chrome uses whatever mic it's set to — no programmatic control
        warn("[CHROMEBRIDGE] Microphone selection not supported in Chrome bridge mode");
    }

    status(): boolean {
        return this.running;
    }

    onResult(callback: (result: string, final: boolean) => void): void {
        this.resultCallback = callback;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private async findChrome(): Promise<string | null> {
        // Try each known path
        for (const path of CHROME_PATHS) {
            if (path && await this.fileExists(path)) {
                return path;
            }
        }

        // Try finding via 'where chrome' command
        try {
            const result = await Command.create('where-chrome', ['where', 'chrome']).execute();
            const line = result.stdout.split('\n')[0].trim();
            if (line && line.endsWith('.exe')) return line;
        } catch (_) {}

        // Try msedge
        try {
            const result = await Command.create('where-edge', ['where', 'msedge']).execute();
            const line = result.stdout.split('\n')[0].trim();
            if (line && line.endsWith('.exe')) return line;
        } catch (_) {}

        return null;
    }

    private async fileExists(path: string): Promise<boolean> {
        try {
            // Use Tauri shell to check file existence
            const result = await Command.create('check-file', ['cmd', '/c', `if exist "${path}" echo yes`]).execute();
            return result.stdout.trim() === 'yes';
        } catch (_) {
            return false;
        }
    }

    private async getTempFilePath(fileName: string): Promise<string> {
        try {
            // Get TEMP env var path
            const result = await Command.create('get-temp', ['cmd', '/c', 'echo %TEMP%']).execute();
            const tempDir = result.stdout.trim();
            return `${tempDir}\\${fileName}`;
        } catch (_) {
            return `C:\\Users\\Public\\${fileName}`;
        }
    }
}
