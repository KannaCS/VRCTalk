import React, { useState, useEffect, useRef } from 'react';
import { Config, saveConfig, speed_presets, WHISPER_MODELS, WhisperModel } from '../utils/config';
import { Whisper } from '../recognizers/Whisper';
import { info, error } from '@tauri-apps/plugin-log';
import { listen } from '@tauri-apps/api/event';

interface SettingsProps {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  onClose?: () => void; // Optional close handler
}

const Settings: React.FC<SettingsProps> = ({ config, setConfig, onClose }) => {
  // Local state to track changes
  const [localConfig, setLocalConfig] = useState<Config>({ ...config });
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{text: string, isError: boolean} | null>(null);
  const [whisperModels, setWhisperModels] = useState<WhisperModel[]>([...WHISPER_MODELS]);
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());
  const [downloadProgress, setDownloadProgress] = useState<Map<string, number>>(new Map());

  // After state declarations
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
    setLocalConfig(prev => ({
      ...prev,
      ...updates
    }));
  };

  const handleSave = async (cfg: Config = localConfig) => {
    setIsSaving(true);
    setSaveMessage(null);
    
    try {
      info('[SETTINGS] Saving configuration changes');
      await saveConfig(cfg);
      setConfig(cfg);
      setSaveMessage({ text: 'Settings saved successfully!', isError: false });
      setHasChanges(false);
      info('[SETTINGS] Configuration saved successfully');
      
      // Auto close after successful save if onClose is provided
      if (onClose) {
        setTimeout(onClose, 1500);
      }
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      error(`[SETTINGS] Error saving configuration: ${errorMessage}`);
      setSaveMessage({ text: `Error saving settings: ${errorMessage}`, isError: true });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    if (hasChanges) {
      info('[SETTINGS] Discarding unsaved changes');
      setLocalConfig({ ...config });
      setHasChanges(false);
    }
    
    if (onClose) {
      onClose();
    }
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

  return (
    <div className="space-y-8">
      {/* Language Settings */}
      <div className="modern-card animate-slide-up">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"></path>
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Language Settings</h3>
            <p className="text-white/60 text-sm">Configure source and target languages</p>
          </div>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-3">
            <label className="block text-sm font-medium text-white/80">
              Source Language
            </label>
            <select
              value={localConfig.source_language}
              onChange={(e) => updateLocalConfig({ source_language: e.target.value })}
              className="select-modern"
            >
              <option value="en-US">English (US)</option>
              <option value="ja-JP">Japanese</option>
              <option value="ko-KR">Korean</option>
              <option value="zh-CN">Chinese (Simplified)</option>
              <option value="es-ES">Spanish</option>
              <option value="fr-FR">French</option>
              <option value="de-DE">German</option>
              <option value="ru-RU">Russian</option>
            </select>
          </div>
          
          <div className="space-y-3">
            <label className="block text-sm font-medium text-white/80">
              Target Language
            </label>
            <select
              value={localConfig.target_language}
              onChange={(e) => updateLocalConfig({ target_language: e.target.value })}
              className="select-modern"
            >
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

      {/* Speech Recognition Settings */}
      <div className="modern-card animate-slide-up animate-delay-100">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Speech Recognition</h3>
            <p className="text-white/60 text-sm">Choose your preferred speech recognition engine</p>
          </div>
        </div>

        <div className="space-y-6">
          {/* Recognizer Selection */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-white/80">
              Recognition Engine
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* WebSpeech Option */}
              <label className={`relative flex items-center p-4 rounded-xl cursor-pointer transition-all duration-300 ${
                localConfig.recognizer === 'webspeech'
                  ? 'bg-gradient-to-r from-blue-500/20 to-purple-600/20 border-2 border-blue-500/50'
                  : 'bg-white/5 border-2 border-transparent hover:bg-white/10'
              }`}>
                <input
                  type="radio"
                  name="recognizer"
                  value="webspeech"
                  checked={localConfig.recognizer === 'webspeech'}
                  onChange={(e) => updateLocalConfig({ recognizer: e.target.value })}
                  className="sr-only"
                />
                <div className="flex-1">
                  <div className="text-white font-medium">WebSpeech API</div>
                  <div className="text-white/60 text-sm mt-1">
                    Browser-based, fast, requires internet
                  </div>
                </div>
                {localConfig.recognizer === 'webspeech' && (
                  <div className="w-5 h-5 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
              </label>

              {/* Whisper Option */}
              <label className={`relative flex items-center p-4 rounded-xl cursor-pointer transition-all duration-300 ${
                localConfig.recognizer === 'whisper'
                  ? 'bg-gradient-to-r from-green-500/20 to-teal-600/20 border-2 border-green-500/50'
                  : 'bg-white/5 border-2 border-transparent hover:bg-white/10'
              }`}>
                <input
                  type="radio"
                  name="recognizer"
                  value="whisper"
                  checked={localConfig.recognizer === 'whisper'}
                  onChange={(e) => updateLocalConfig({ recognizer: e.target.value })}
                  className="sr-only"
                />
                <div className="flex-1">
                  <div className="text-white font-medium">OpenAI Whisper</div>
                  <div className="text-white/60 text-sm mt-1">
                    Local processing, works offline, high accuracy
                  </div>
                </div>
                {localConfig.recognizer === 'whisper' && (
                  <div className="w-5 h-5 rounded-full bg-gradient-to-r from-green-500 to-teal-600 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
              </label>
            </div>
          </div>

          {/* Whisper Model Selection */}
          {localConfig.recognizer === 'whisper' && (
            <div className="space-y-4 pt-4 border-t border-white/10">
              <div className="flex items-center justify-between">
                <label className="block text-sm font-medium text-white/80">
                  Whisper Model
                </label>
                <div className="text-xs text-white/50">
                  Download required models first
                </div>
              </div>

              <div className="space-y-3">
                {whisperModels.map((model) => (
                  <div key={model.id} className="flex items-center justify-between p-4 bg-white/5 rounded-xl">
                    <div className="flex items-center space-x-4 flex-1">
                      {/* Model Selection Radio */}
                      <label className="flex items-center cursor-pointer">
                        <input
                          type="radio"
                          name="whisper_model"
                          value={model.id}
                          checked={localConfig.whisper_model === model.id}
                          onChange={(e) => updateLocalConfig({ whisper_model: e.target.value })}
                          disabled={!model.downloaded}
                          className="sr-only"
                        />
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                          model.downloaded
                            ? (localConfig.whisper_model === model.id
                                ? 'border-green-500 bg-green-500'
                                : 'border-white/30 hover:border-green-500')
                            : 'border-white/20 cursor-not-allowed'
                        }`}>
                          {localConfig.whisper_model === model.id && model.downloaded && (
                            <div className="w-2 h-2 rounded-full bg-white"></div>
                          )}
                        </div>
                      </label>

                      {/* Model Info */}
                      <div className="flex-1">
                        <div className="flex items-center space-x-2">
                          <span className={`font-medium ${model.downloaded ? 'text-white' : 'text-white/50'}`}>
                            {model.name}
                          </span>
                          <span className="text-xs text-white/40">({model.size})</span>
                          {model.downloaded && (
                            <div className="flex items-center space-x-1 text-xs text-green-400">
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                              <span>Downloaded</span>
                            </div>
                          )}
                        </div>
                        <div className="text-xs text-white/50 mt-1">{model.quality}</div>
                      </div>
                    </div>

                    {/* Download Button */}
                    {!model.downloaded && (
                      <div className="flex flex-col items-end space-y-2">
                        {downloadingModels.has(model.id) && downloadProgress.has(model.id) && (
                          <div className="text-xs text-white/70">
                            {downloadProgress.get(model.id)}%
                          </div>
                        )}
                        <button
                          onClick={() => handleDownloadModel(model.id)}
                          disabled={downloadingModels.has(model.id)}
                          className={`btn-modern text-xs px-3 py-2 flex items-center space-x-2 ${
                            downloadingModels.has(model.id)
                              ? 'bg-white/10 text-white/50 cursor-not-allowed'
                              : 'btn-primary'
                          }`}
                        >
                          {downloadingModels.has(model.id) ? (
                            <>
                              <svg className="w-3 h-3 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                              </svg>
                              <span>
                                {downloadProgress.has(model.id)
                                  ? `${downloadProgress.get(model.id)}%`
                                  : 'Downloading...'
                                }
                              </span>
                            </>
                          ) : (
                            <>
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"></path>
                              </svg>
                              <span>Download</span>
                            </>
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Model Selection Info */}
              <div className="text-xs text-white/50 bg-white/5 rounded-lg p-3">
                <strong>Model Guide:</strong> Tiny/Base for real-time use, Small/Medium for balanced performance, Large for best accuracy.
                Models are downloaded once and stored locally for offline use.
              </div>
            </div>
          )}
        </div>
      </div>
      
      {/* VRChat Settings */}
      <div className="modern-card animate-slide-up animate-delay-200">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-blue-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">VRChat Integration</h3>
            <p className="text-white/60 text-sm">Configure VRChat-specific features</p>
          </div>
        </div>
        
        <div className="space-y-6">
          {/* Disable when muted toggle */}
          <div className="flex items-center justify-between p-4 bg-white/5 rounded-xl">
            <div className="flex-1">
              <h4 className="text-white font-medium">Disable when muted</h4>
              <p className="text-white/60 text-sm mt-1">
                Automatically pause translation when you're muted in VRChat
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer ml-4">
              <input
                type="checkbox"
                checked={localConfig.vrchat_settings.disable_when_muted}
                onChange={(e) => updateLocalConfig({ 
                  vrchat_settings: {
                    ...localConfig.vrchat_settings,
                    disable_when_muted: e.target.checked
                  }
                })}
                className="sr-only peer"
              />
              <div className="relative w-11 h-6 bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-gradient-to-r peer-checked:from-blue-500 peer-checked:to-purple-600"></div>
            </label>
          </div>
          
          {/* Speech Speed Setting */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-white/80">
              Chatbox Update Speed
            </label>
            <div className="relative">
              <select
                value={String(localConfig.vrchat_settings.chatbox_update_speed)}
                onChange={(e) => updateLocalConfig({ 
                  vrchat_settings: {
                    ...localConfig.vrchat_settings,
                    chatbox_update_speed: Number(e.target.value)
                  }
                })}
                className="select-modern"
              >
                {Object.entries(speed_presets).map(([key, value]) => (
                  <option key={key} value={String(value)}>
                    {key.charAt(0).toUpperCase() + key.slice(1)} ({value}ms)
                  </option>
                ))}
              </select>
            </div>
            <p className="text-white/50 text-xs">
              Controls how quickly messages appear in VRChat's chatbox
            </p>
          </div>
        </div>
      </div>

      {/* Advanced Settings */}
      <div className="modern-card animate-slide-up animate-delay-300">
        <div className="flex items-center space-x-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
            </svg>
          </div>
          <div>
            <h3 className="text-xl font-semibold text-white">Advanced Settings</h3>
            <p className="text-white/60 text-sm">Fine-tune your translation experience</p>
          </div>
        </div>
        
        <div className="space-y-6">
          {/* Mode Selection */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-white/80">
              Operation Mode
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className={`relative flex items-center p-4 rounded-xl cursor-pointer transition-all duration-300 ${
                localConfig.mode === 0 
                  ? 'bg-gradient-to-r from-blue-500/20 to-purple-600/20 border-2 border-blue-500/50' 
                  : 'bg-white/5 border-2 border-transparent hover:bg-white/10'
              }`}>
                <input
                  type="radio"
                  name="mode"
                  value={0}
                  checked={localConfig.mode === 0}
                  onChange={(e) => updateLocalConfig({ mode: Number(e.target.value) })}
                  className="sr-only"
                />
                <div className="flex-1">
                  <div className="text-white font-medium">Translation Mode</div>
                  <div className="text-white/60 text-sm mt-1">
                    Translate speech and send to VRChat
                  </div>
                </div>
                {localConfig.mode === 0 && (
                  <div className="w-5 h-5 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
              </label>
              
              <label className={`relative flex items-center p-4 rounded-xl cursor-pointer transition-all duration-300 ${
                localConfig.mode === 1 
                  ? 'bg-gradient-to-r from-green-500/20 to-blue-600/20 border-2 border-green-500/50' 
                  : 'bg-white/5 border-2 border-transparent hover:bg-white/10'
              }`}>
                <input
                  type="radio"
                  name="mode"
                  value={1}
                  checked={localConfig.mode === 1}
                  onChange={(e) => updateLocalConfig({ mode: Number(e.target.value) })}
                  className="sr-only"
                />
                <div className="flex-1">
                  <div className="text-white font-medium">Transcription Mode</div>
                  <div className="text-white/60 text-sm mt-1">
                    Send speech directly without translation
                  </div>
                </div>
                {localConfig.mode === 1 && (
                  <div className="w-5 h-5 rounded-full bg-gradient-to-r from-green-500 to-blue-600 flex items-center justify-center">
                    <svg className="w-3 h-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
              </label>
            </div>
          </div>
        </div>
      </div>
      
      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row justify-end space-y-3 sm:space-y-0 sm:space-x-4 animate-slide-up animate-delay-400">
        {/* Save Message */}
        {saveMessage && (
          <div className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-sm font-medium ${
            saveMessage.isError 
              ? 'bg-red-500/20 text-red-300 border border-red-500/30' 
              : 'bg-green-500/20 text-green-300 border border-green-500/30'
          }`}>
            {saveMessage.isError ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
              </svg>
            )}
            <span>{saveMessage.text}</span>
          </div>
        )}
        
        <div className="flex space-x-3">
          <button
            onClick={handleCancel}
            className="btn-modern bg-white/10 hover:bg-white/20 text-white border border-white/20"
          >
            Cancel
          </button>
          <button
            onClick={() => { void handleSave(); }}
            disabled={isSaving || !hasChanges}
            className={`btn-modern flex items-center space-x-2 ${
              hasChanges 
                ? 'btn-success' 
                : 'bg-white/10 text-white/50 cursor-not-allowed'
            }`}
          >
            {isSaving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
                </svg>
                <span>Saving...</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <span>Save Changes</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings;