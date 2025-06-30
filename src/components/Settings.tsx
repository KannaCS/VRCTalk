import React, { useState, useEffect, useRef } from 'react';
import { Config, saveConfig, speed_presets } from '../utils/config';
import { info, error } from '@tauri-apps/plugin-log';

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

  return (
    <div className="text-white">
      <div className="space-y-6">
        {/* Language Settings */}
        <div>
          <h3 className="text-lg font-medium text-white mb-3">Language Settings</h3>
          <div className="bg-gray-800 rounded-lg p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Source Language</label>
              <select
                value={localConfig.source_language}
                onChange={(e) => updateLocalConfig({ source_language: e.target.value })}
                className="w-full bg-gray-700 text-white rounded-md px-3 py-2 border border-gray-600 focus:border-blue-500 focus:ring focus:ring-blue-500/20 focus:outline-none"
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
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Target Language</label>
              <select
                value={localConfig.target_language}
                onChange={(e) => updateLocalConfig({ target_language: e.target.value })}
                className="w-full bg-gray-700 text-white rounded-md px-3 py-2 border border-gray-600 focus:border-blue-500 focus:ring focus:ring-blue-500/20 focus:outline-none"
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
        
        {/* VRChat Settings */}
        <div>
          <h3 className="text-lg font-medium text-white mb-3">VRChat Settings</h3>
          <div className="bg-gray-800 rounded-lg p-4 space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="disable-when-muted"
                checked={localConfig.vrchat_settings.disable_when_muted}
                onChange={(e) => updateLocalConfig({ 
                  vrchat_settings: {
                    ...localConfig.vrchat_settings,
                    disable_when_muted: e.target.checked
                  }
                })}
                className="form-checkbox h-5 w-5 text-blue-600"
              />
              <label htmlFor="disable-when-muted" className="ml-2 text-white">
                Disable translation when muted in VRChat
              </label>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Speech Speed</label>
              <select
                value={String(localConfig.vrchat_settings.chatbox_update_speed)}
                onChange={(e) => updateLocalConfig({ 
                  vrchat_settings: {
                    ...localConfig.vrchat_settings,
                    chatbox_update_speed: Number(e.target.value)
                  }
                })}
                className="w-full bg-gray-700 text-white rounded-md px-3 py-2 border border-gray-600 focus:border-blue-500 focus:ring focus:ring-blue-500/20 focus:outline-none appearance-auto"
                style={{ color: 'white', backgroundColor: '#374151' }}
              >
                {Object.entries(speed_presets).map(([key, value]) => (
                  <option key={key} value={String(value)} style={{ backgroundColor: '#374151', color: 'white' }}>
                    {key.charAt(0).toUpperCase() + key.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        
        {/* Action Buttons */}
        <div className="flex justify-end space-x-3 mt-6">
          {saveMessage && (
            <div className={`py-2 px-3 rounded text-sm ${saveMessage.isError ? 'bg-red-900/50 text-red-200' : 'bg-green-900/50 text-green-200'}`}>
              {saveMessage.text}
            </div>
          )}
          <button
            onClick={handleCancel}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { void handleSave(); }}
            disabled={isSaving || !hasChanges}
            className={`px-4 py-2 rounded-md transition-colors ${
              hasChanges 
                ? 'bg-blue-600 hover:bg-blue-500 text-white' 
                : 'bg-blue-600/50 text-white/70 cursor-not-allowed'
            }`}
          >
            {isSaving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default Settings; 