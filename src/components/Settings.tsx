import React, { useState, useEffect, useRef } from 'react';
import { Config, saveConfig, speed_presets, WHISPER_MODELS, WhisperModel } from '../utils/config';
import { Whisper } from '../recognizers/Whisper';
import { info, error } from '@tauri-apps/plugin-log';
import { listen } from '@tauri-apps/api/event';

interface SettingsProps {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  onClose?: () => void;
}

type SettingsSection = 'language' | 'speech' | 'translation' | 'appearance' | 'vrchat';

const Settings: React.FC<SettingsProps> = ({ config, setConfig, onClose }) => {
  const [localConfig, setLocalConfig] = useState<Config>({ ...config });
  const [hasChanges, setHasChanges] = useState(false);

  const [saveMessage, setSaveMessage] = useState<{ text: string, isError: boolean } | null>(null);
  const [whisperModels, setWhisperModels] = useState<WhisperModel[]>([...WHISPER_MODELS]);
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());
  const [downloadProgress, setDownloadProgress] = useState<Map<string, number>>(new Map());
  const [activeSection, setActiveSection] = useState<SettingsSection>('language');

  const hasChangesRef = useRef(hasChanges);
  const latestConfigRef = useRef(localConfig);

  // Keep refs updated with the latest state on every render
  useEffect(() => {
    hasChangesRef.current = hasChanges;
    latestConfigRef.current = localConfig;
  }, [hasChanges, localConfig]);

  // Update local config when the parent config changes
  useEffect(() => {
    setLocalConfig({ ...config });
  }, [config]);

  // Check for unsaved changes
  useEffect(() => {
    const configChanged = JSON.stringify(localConfig) !== JSON.stringify(config);
    setHasChanges(configChanged);

    if (configChanged) {
      info('[SETTINGS] Unsaved changes detected');
    }
  }, [localConfig, config]);

  useEffect(() => {
    // Log when the Settings component is mounted
    info('[SETTINGS] Component mounted as modal');

    return () => {
      info('[SETTINGS] Settings modal closing');
      // Auto-save changes when closing if there are unsaved changes
      if (hasChangesRef.current) {
        info('[SETTINGS] Auto-saving changes on modal close');
        // Persist directly without touching local component state to avoid memory leaks
        const cfgToSave = latestConfigRef.current;
        saveConfig(cfgToSave)
          .then(() => {
            setConfig(cfgToSave);
            info('[SETTINGS] Auto-save completed');
          })
          .catch(e => {
            const errorMessage = e instanceof Error ? e.message : String(e);
            error(`[SETTINGS] Auto-save failed: ${errorMessage}`);
          });
      }
    };
  }, []);

  // Load Whisper model status on component mount
  useEffect(() => {
    const loadWhisperModelStatus = async () => {
      try {
        const downloadedModels = await Whisper.getDownloadedModels();
        setWhisperModels(prevModels =>
          prevModels.map(model => ({
            ...model,
            downloaded: downloadedModels.includes(model.id)
          }))
        );

        // Check for any ongoing downloads by checking if we receive progress events
        // If we get progress events within 2 seconds, assume downloads are ongoing
        const progressCheckTimeout = setTimeout(() => {
          // If no progress events received, clear any stale downloading states
          setDownloadingModels(new Set());
          setDownloadProgress(new Map());
        }, 2000);

        // Store timeout ID to clear it if progress events are received
        (window as any).__progressCheckTimeout = progressCheckTimeout;

      } catch (err) {
        error(`[SETTINGS] Error loading Whisper model status: ${err}`);
      }
    };

    loadWhisperModelStatus();
  }, []);

  // Listen for download progress events
  useEffect(() => {
    const unlisten = listen('download-progress', (event) => {
      const payload = event.payload as { model: string; file: string; progress: number; downloaded: number; total: number };

      // Clear the progress check timeout if it exists (indicates ongoing download)
      if ((window as any).__progressCheckTimeout) {
        clearTimeout((window as any).__progressCheckTimeout);
        (window as any).__progressCheckTimeout = null;
      }

      // If we receive progress events, it means download is ongoing
      // Set the model as downloading if not already set
      setDownloadingModels(prev => {
        if (!prev.has(payload.model)) {
          const newSet = new Set(prev);
          newSet.add(payload.model);
          return newSet;
        }
        return prev;
      });

      setDownloadProgress(prev => {
        const newProgress = new Map(prev);
        newProgress.set(payload.model, Math.round(payload.progress));
        return newProgress;
      });

      info(`[SETTINGS] Download progress for ${payload.model}: ${Math.round(payload.progress)}% (${payload.file})`);

      // If progress reaches 100%, the download is complete
      if (payload.progress >= 100) {
        setTimeout(() => {
          setDownloadingModels(prev => {
            const newSet = new Set(prev);
            newSet.delete(payload.model);
            return newSet;
          });

          setDownloadProgress(prev => {
            const newProgress = new Map(prev);
            newProgress.delete(payload.model);
            return newProgress;
          });

          // Refresh model status to show as downloaded
          Whisper.getDownloadedModels().then(downloadedModels => {
            setWhisperModels(prevModels =>
              prevModels.map(model => ({
                ...model,
                downloaded: downloadedModels.includes(model.id)
              }))
            );
          }).catch(err => {
            error(`[SETTINGS] Error refreshing model status: ${err}`);
          });

          setSaveMessage({ text: `Model ${payload.model} downloaded successfully!`, isError: false });
          setTimeout(() => setSaveMessage(null), 5000);
        }, 1000); // Small delay to ensure backend has finished processing
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, []);

  const updateLocalConfig = (updates: Partial<Config>) => {
    setLocalConfig(prev => {
      const newConfig = { ...prev, ...updates };
      setConfig(newConfig);
      saveConfig(newConfig).catch(e => {
        const errorMessage = e instanceof Error ? e.message : String(e);
        error(`[SETTINGS] Auto-save failed: ${errorMessage}`);
      });
      return newConfig;
    });
  };





  const handleDownloadModel = async (modelId: string) => {
    setDownloadingModels(prev => new Set(prev).add(modelId));
    setDownloadProgress(prev => {
      const newProgress = new Map(prev);
      newProgress.set(modelId, 0);
      return newProgress;
    });
    setSaveMessage(null); // Clear any previous messages

    try {
      info(`[SETTINGS] Starting download for Whisper model: ${modelId}`);

      // Add timeout to prevent hanging (increased to 5 minutes for large models)
      const downloadPromise = Whisper.downloadModel(modelId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Download timeout after 5 minutes')), 300000)
      );

      const success = await Promise.race([downloadPromise, timeoutPromise]);

      if (success) {
        info(`[SETTINGS] Model ${modelId} downloaded successfully`);
        setWhisperModels(prevModels =>
          prevModels.map(model =>
            model.id === modelId
              ? { ...model, downloaded: true, downloading: false }
              : model
          )
        );
        setSaveMessage({ text: `Model ${modelId} downloaded successfully!`, isError: false });

        // Auto-clear success message after 5 seconds
        setTimeout(() => setSaveMessage(null), 5000);
      } else {
        error(`[SETTINGS] Failed to download model ${modelId}`);
        setSaveMessage({ text: `Failed to download model ${modelId}`, isError: true });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      error(`[SETTINGS] Error downloading model ${modelId}: ${errorMessage}`);
      setSaveMessage({
        text: `Error downloading model: ${errorMessage}`,
        isError: true
      });
    } finally {
      // Always clear the downloading state and progress, even if there was an error
      setDownloadingModels(prev => {
        const next = new Set(prev);
        next.delete(modelId);
        return next;
      });

      setDownloadProgress(prev => {
        const newProgress = new Map(prev);
        newProgress.delete(modelId);
        return newProgress;
      });

      info(`[SETTINGS] Download process completed for model: ${modelId}`);
    }
  };

  // Toggle component for clean switches
  const Toggle = ({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) => (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <div className="settings-toggle-track"></div>
      <div className="settings-toggle-thumb"></div>
    </label>
  );

  return (
    <div className={`settings-container theme-${localConfig.theme_color}`}>
      {/* Sidebar */}
      <div className="settings-sidebar animate-slide-right">
        <div className="settings-sidebar-header flex items-center justify-between">
          <div>
            <div className="settings-sidebar-title">Settings</div>
            <div className="settings-sidebar-version">v0.3.2</div>
          </div>
          <button onClick={() => onClose?.()} className="p-2 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-all">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <nav className="settings-sidebar-nav space-y-1">
          <button onClick={() => setActiveSection('language')} className={`settings-nav-item w-full ${activeSection === 'language' ? 'active' : ''}`}>
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" /></svg>
            <span>Language</span>
          </button>
          <button onClick={() => setActiveSection('speech')} className={`settings-nav-item w-full ${activeSection === 'speech' ? 'active' : ''}`}>
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            <span>Speech</span>
          </button>
          <button onClick={() => setActiveSection('translation')} className={`settings-nav-item w-full ${activeSection === 'translation' ? 'active' : ''}`}>
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg>
            <span>Translation</span>
          </button>
          <button onClick={() => setActiveSection('appearance')} className={`settings-nav-item w-full ${activeSection === 'appearance' ? 'active' : ''}`}>
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" /></svg>
            <span>Appearance</span>
          </button>
          <button onClick={() => setActiveSection('vrchat')} className={`settings-nav-item w-full ${activeSection === 'vrchat' ? 'active' : ''}`}>
            <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
            <span>VRChat</span>
          </button>
        </nav>
        <div className="mt-auto pt-4 border-t border-white/5">
          <a
            href="mailto:support@vrctalk.com"
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-white/60 hover:text-white hover:bg-white/5 transition-all duration-200"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span>Contact Us</span>
          </a>
        </div>
      </div>

      {/* Main Content */}
      <div className="settings-main animate-fade-in">
        <div className="settings-header">
          <h1>Settings</h1>
          <p>Configure your translation preferences and interface options</p>
        </div>

        {saveMessage && (
          <div className={`mb-6 flex items-center gap-2 px-4 py-3 rounded-lg text-sm ${saveMessage.isError ? 'bg-red-500/20 text-red-300 border border-red-500/30' : 'bg-green-500/20 text-green-300 border border-green-500/30'}`}>
            <span>{saveMessage.text}</span>
          </div>
        )}

        {/* Language Defaults */}
        {activeSection === 'language' && (
          <section className="settings-section animate-slide-up">
            <h2 className="settings-section-title">Language Defaults</h2>
            <div className="settings-card">
              <div className="settings-grid-2">
                <div className="settings-field">
                  <label className="settings-label">Default Source Language</label>
                  <select value={localConfig.source_language} onChange={(e) => updateLocalConfig({ source_language: e.target.value })} className="settings-select">
                    <option value="en-US">English (United States)</option>
                    <option value="ja-JP">Japanese</option>
                    <option value="ko-KR">Korean</option>
                    <option value="zh-CN">Chinese (Simplified)</option>
                    <option value="es-ES">Spanish (Spain)</option>
                    <option value="fr-FR">French</option>
                    <option value="de-DE">German</option>
                    <option value="ru-RU">Russian</option>
                  </select>
                </div>
                <div className="settings-field">
                  <label className="settings-label">Default Target Language</label>
                  <select value={localConfig.target_language} onChange={(e) => updateLocalConfig({ target_language: e.target.value })} className="settings-select">
                    <option value="ja">Japanese</option>
                    <option value="en">English</option>
                    <option value="ko">Korean</option>
                    <option value="zh-CN">Chinese (Simplified)</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="ru">Russian</option>
                  </select>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Speech & Audio */}
        {activeSection === 'speech' && (
          <section className="settings-section animate-slide-up">
            <h2 className="settings-section-title">Speech & Audio</h2>
            <div className="settings-card">
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Enable Live Translation</div>
                  <div className="settings-row-description">Translate speech in real-time as you speak</div>
                </div>
                <Toggle checked={localConfig.mode === 0} onChange={(checked) => updateLocalConfig({ mode: checked ? 0 : 1 })} />
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Recognition Engine</div>
                  <div className="settings-row-description">WebSpeech (online) or Whisper (offline, higher accuracy)</div>
                </div>
                <select value={localConfig.recognizer} onChange={(e) => updateLocalConfig({ recognizer: e.target.value })} className="settings-select" style={{ width: '160px' }}>
                  <option value="webspeech">WebSpeech API</option>
                  <option value="whisper">OpenAI Whisper</option>
                </select>
              </div>
              {localConfig.recognizer === 'whisper' && (
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-title">Whisper Model</div>
                    <div className="settings-row-description">Larger models = better accuracy, slower speed</div>
                  </div>
                  <select value={localConfig.whisper_model} onChange={(e) => updateLocalConfig({ whisper_model: e.target.value })} className="settings-select" style={{ width: '160px' }}>
                    {whisperModels.map((model) => (
                      <option key={model.id} value={model.id} disabled={!model.downloaded}>
                        {model.name} {model.downloaded ? '' : '(Download)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {localConfig.recognizer === 'whisper' && (
                <div className="mt-4 space-y-2">
                  {whisperModels.filter(m => !m.downloaded).map((model) => (
                    <div key={model.id} className="settings-model-card">
                      <div className="settings-model-info">
                        <div className="settings-model-details">
                          <h4>{model.name} <span>({model.size})</span></h4>
                          <span>{model.quality}</span>
                        </div>
                      </div>
                      <button onClick={() => handleDownloadModel(model.id)} disabled={downloadingModels.has(model.id)} className="settings-model-btn">
                        {downloadingModels.has(model.id) ? `${downloadProgress.get(model.id) || 0}%` : 'Download'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* Translation */}
        {activeSection === 'translation' && (
          <section className="settings-section animate-slide-up">
            <h2 className="settings-section-title">Translation</h2>
            <div className="settings-card">
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Translation Provider</div>
                  <div className="settings-row-description">Google (free), Gemini or Groq (AI-powered, needs API key)</div>
                </div>
                <select value={localConfig.translator} onChange={(e) => updateLocalConfig({ translator: e.target.value })} className="settings-select" style={{ width: '160px' }}>
                  <option value="google">Google Translate</option>
                  <option value="gemini">Gemini Flash</option>
                  <option value="groq">Groq (Llama 3.3)</option>
                </select>
              </div>
              {localConfig.translator === 'gemini' && (
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-title">Gemini API Key</div>
                    <div className="settings-row-description">Get free key from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">Google AI Studio</a></div>
                  </div>
                  <input type="password" value={localConfig.gemini_api_key} onChange={(e) => updateLocalConfig({ gemini_api_key: e.target.value })} placeholder="Enter API key" className="settings-input" style={{ width: '200px' }} />
                </div>
              )}
              {localConfig.translator === 'groq' && (
                <div className="settings-row">
                  <div className="settings-row-info">
                    <div className="settings-row-title">Groq API Key (Optional)</div>
                    <div className="settings-row-description">Built-in keys provided. Add your own from <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-orange-400 hover:underline">Groq Console</a> for priority access</div>
                  </div>
                  <input type="password" value={localConfig.groq_api_key} onChange={(e) => updateLocalConfig({ groq_api_key: e.target.value })} placeholder="Optional - uses built-in" className="settings-input" style={{ width: '200px' }} />
                </div>
              )}
            </div>
          </section>
        )}

        {/* Appearance */}
        {activeSection === 'appearance' && (
          <section className="settings-section animate-slide-up">
            <h2 className="settings-section-title">Appearance</h2>
            <div className="settings-card">
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Theme Color</div>
                  <div className="settings-row-description">Choose your accent color</div>
                </div>
                <div className="settings-color-grid">
                  {['blue', 'purple', 'green', 'orange', 'pink', 'red'].map((color) => (
                    <button key={color} onClick={() => updateLocalConfig({ theme_color: color })} className={`settings-color-swatch ${localConfig.theme_color === color ? 'active' : ''}`} style={{ background: `linear-gradient(135deg, var(--tw-gradient-stops))`, ['--tw-gradient-from' as string]: color === 'blue' ? '#60a5fa' : color === 'purple' ? '#a78bfa' : color === 'green' ? '#4ade80' : color === 'orange' ? '#fb923c' : color === 'pink' ? '#f472b6' : '#f87171', ['--tw-gradient-to' as string]: color === 'blue' ? '#3b82f6' : color === 'purple' ? '#8b5cf6' : color === 'green' ? '#22c55e' : color === 'orange' ? '#f97316' : color === 'pink' ? '#ec4899' : '#ef4444', ['--tw-gradient-stops' as string]: 'var(--tw-gradient-from), var(--tw-gradient-to)' }} title={color} />
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {/* VRChat */}
        {activeSection === 'vrchat' && (
          <section className="settings-section animate-slide-up">
            <h2 className="settings-section-title">VRChat Integration</h2>
            <div className="settings-card">
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Disable When Muted</div>
                  <div className="settings-row-description">Pause translation when muted in VRChat</div>
                </div>
                <Toggle checked={localConfig.vrchat_settings.disable_when_muted} onChange={(checked) => updateLocalConfig({ vrchat_settings: { ...localConfig.vrchat_settings, disable_when_muted: checked } })} />
              </div>
              <div className="settings-row">
                <div className="settings-row-info">
                  <div className="settings-row-title">Chatbox Update Speed</div>
                  <div className="settings-row-description">How quickly messages appear in VRChat</div>
                </div>
                <select value={String(localConfig.vrchat_settings.chatbox_update_speed)} onChange={(e) => updateLocalConfig({ vrchat_settings: { ...localConfig.vrchat_settings, chatbox_update_speed: Number(e.target.value) } })} className="settings-select" style={{ width: '140px' }}>
                  {Object.entries(speed_presets).map(([key, value]) => (
                    <option key={key} value={String(value)}>{key.charAt(0).toUpperCase() + key.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>
          </section>
        )}

        {/* Action Buttons */}

      </div>
    </div>
  );
};

export default Settings;
