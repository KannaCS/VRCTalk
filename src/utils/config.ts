import { readTextFile, writeTextFile, exists, create } from '@tauri-apps/plugin-fs';
import { appConfigDir } from '@tauri-apps/api/path';
import { info, error } from '@tauri-apps/plugin-log';

// import { Store } from '@tauri-apps/plugin-fs';

export const speed_presets = {
    slow: 1000,
    medium: 500,
    fast: 200
};

export type Config = {
    source_language: string;
    target_language: string;
    mode: number;    // 0 = translation, 1 = transcription only
    selected_microphone: string | null; // Device ID for selected microphone
    language_settings: {
        omit_questionmark: boolean;
        gender_change: boolean;
        gender_change_type: number;  // 0 = make masculine, 1 = make feminine
    };
    vrchat_settings: {
        translation_first: boolean;
        only_translation: boolean;
        disable_when_muted: boolean;
        send_typing_status_while_talking: boolean;
        chatbox_update_speed: number;
        osc_address: string;
        osc_port: number;
    };
}

export const DEFAULT_CONFIG: Config = {
    source_language: "en-US",
    target_language: "ja",
    mode: 0,
    selected_microphone: null, // Default to system default microphone
    language_settings: {
        omit_questionmark: true,
        gender_change: false,
        gender_change_type: 0
    },
    vrchat_settings: {
        translation_first: true,
        only_translation: false,
        disable_when_muted: false,
        send_typing_status_while_talking: true,
        chatbox_update_speed: speed_presets.slow,
        osc_address: "127.0.0.1",
        osc_port: 9000
    }
};

// Get the config file path
async function getConfigPath(): Promise<string> {
    const configDir = await appConfigDir();
    return `${configDir}/config.json`;
}

// Load configuration from file
export async function loadConfig(): Promise<Config> {
    try {
        const configPath = await getConfigPath();
        const configDir = await appConfigDir();
        
        // Check if config directory exists, create if not
        if (!(await exists(configDir))) {
            // Create directory without options
            await create(configDir);
            info('[CONFIG] Created config directory');
        }
        
        // Check if config file exists
        if (await exists(configPath)) {
            info('[CONFIG] Loading config from file');
            const configJson = await readTextFile(configPath);
            const loadedConfig = JSON.parse(configJson);
            
            // Validate and merge with defaults to ensure all fields exist
            return validateConfig(loadedConfig);
        } else {
            info('[CONFIG] Config file not found, using defaults');
            // Save default config for future use
            await saveConfig(DEFAULT_CONFIG);
            return DEFAULT_CONFIG;
        }
    } catch (e) {
        error(`[CONFIG] Error loading config: ${e}`);
        return DEFAULT_CONFIG;
    }
}

// Save configuration to file
export async function saveConfig(config: Config): Promise<void> {
    try {
        const configPath = await getConfigPath();
        const configDir = await appConfigDir();
        
        // Ensure config directory exists
        if (!(await exists(configDir))) {
            // Create directory without options
            await create(configDir);
        }
        
        // Validate config before saving
        const validatedConfig = validateConfig(config);
        
        // Save to file
        await writeTextFile(configPath, JSON.stringify(validatedConfig, null, 2));
        info('[CONFIG] Config saved successfully');
    } catch (e) {
        error(`[CONFIG] Error saving config: ${e}`);
    }
}

export function validateConfig(config: Config): Config {
    const validated = { ...DEFAULT_CONFIG };
    
    // Copy valid values from the provided config
    if (config.source_language) validated.source_language = config.source_language;
    if (config.target_language) validated.target_language = config.target_language;
    if (typeof config.mode === 'number') validated.mode = config.mode;
    // Microphone selection is no longer user-configurable – always use system default
    validated.selected_microphone = null;
    
    // Language settings
    if (config.language_settings) {
        if (typeof config.language_settings.omit_questionmark === 'boolean') 
            validated.language_settings.omit_questionmark = config.language_settings.omit_questionmark;
        if (typeof config.language_settings.gender_change === 'boolean') 
            validated.language_settings.gender_change = config.language_settings.gender_change;
        if (typeof config.language_settings.gender_change_type === 'number') 
            validated.language_settings.gender_change_type = config.language_settings.gender_change_type;
    }
    
    // VRChat settings
    if (config.vrchat_settings) {
        if (typeof config.vrchat_settings.translation_first === 'boolean') 
            validated.vrchat_settings.translation_first = config.vrchat_settings.translation_first;
        if (typeof config.vrchat_settings.only_translation === 'boolean') 
            validated.vrchat_settings.only_translation = config.vrchat_settings.only_translation;
        if (typeof config.vrchat_settings.disable_when_muted === 'boolean') 
            validated.vrchat_settings.disable_when_muted = config.vrchat_settings.disable_when_muted;
        if (typeof config.vrchat_settings.send_typing_status_while_talking === 'boolean') 
            validated.vrchat_settings.send_typing_status_while_talking = config.vrchat_settings.send_typing_status_while_talking;
        if (typeof config.vrchat_settings.chatbox_update_speed === 'number') 
            validated.vrchat_settings.chatbox_update_speed = config.vrchat_settings.chatbox_update_speed;
        if (config.vrchat_settings.osc_address) 
            validated.vrchat_settings.osc_address = config.vrchat_settings.osc_address;
        if (typeof config.vrchat_settings.osc_port === 'number') 
            validated.vrchat_settings.osc_port = config.vrchat_settings.osc_port;
    }
    
    return validated;
} 