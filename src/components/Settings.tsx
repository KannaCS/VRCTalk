import React, { useState, useEffect } from 'react';
import { Config, DEFAULT_CONFIG, saveConfig, speed_presets } from '../utils/config';

interface SettingsProps {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
}

const Settings: React.FC<SettingsProps> = ({ config, setConfig }) => {
  const [activeTab, setActiveTab] = useState<'translation'|'vrchat'|'audio'>('translation');
  const [availableMicrophones, setAvailableMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMics, setLoadingMics] = useState(true);
  
  // Update config and save changes
  const updateConfig = (newConfig: Config) => {
    setConfig(newConfig);
    saveConfig(newConfig);
  };
  
  // Reset to default config
  const handleReset = () => {
    if (window.confirm('Are you sure you want to reset all settings to default?')) {
      updateConfig(DEFAULT_CONFIG);
    }
  };

  // Load available microphones
  useEffect(() => {
    const loadMicrophones = async () => {
      try {
        setLoadingMics(true);
        const devices = await navigator.mediaDevices.getUserMedia({ audio: true })
          .then(() => navigator.mediaDevices.enumerateDevices());
        
        const audioInputs = devices.filter(device => device.kind === 'audioinput');
        setAvailableMicrophones(audioInputs);
      } catch (error) {
        console.error('Error loading microphones:', error);
      } finally {
        setLoadingMics(false);
      }
    };
    
    loadMicrophones();
  }, []);
  
  // Get friendly name for the microphone
  const getMicrophoneName = (deviceInfo: MediaDeviceInfo) => {
    // Extract mic name from format "Device name (identifier)"
    const match = deviceInfo.label.match(/^(.*?)(\s+\([^)]+\))?$/);
    return match ? match[1] : deviceInfo.label || `Microphone (${deviceInfo.deviceId.slice(0, 8)}...)`;
  };

  return (
    <div className="flex flex-col space-y-5">
      {/* Header */}
      <div className="card p-5 animate-slide-up">
        <h2 className="text-2xl font-bold text-gray-800 mb-4">Settings</h2>
        
        {/* Tabs */}
        <div className="flex space-x-2 border-b pb-2">
          <button 
            className={`px-4 py-2 rounded-t-md font-medium transition-all duration-300 ${
              activeTab === 'translation' 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            onClick={() => setActiveTab('translation')}
          >
            Translation
          </button>
          <button 
            className={`px-4 py-2 rounded-t-md font-medium transition-all duration-300 ${
              activeTab === 'audio' 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            onClick={() => setActiveTab('audio')}
          >
            Audio
          </button>
          <button 
            className={`px-4 py-2 rounded-t-md font-medium transition-all duration-300 ${
              activeTab === 'vrchat' 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
            onClick={() => setActiveTab('vrchat')}
          >
            VRChat
          </button>
          
          <div className="ml-auto">
            <button 
              onClick={handleReset} 
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-medium rounded-md transition-colors duration-300 shadow-sm"
            >
              Reset to Default
            </button>
          </div>
        </div>
      </div>
      
      {/* Translation Settings */}
      {activeTab === 'translation' && (
        <div className="card p-5 animate-fade-in">
          <div className="space-y-6">
            {/* Mode Section */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">Translation Mode</h3>
              
              <div className="space-y-3">
                <label className="flex items-center p-3 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="radio"
                    id="mode-translate"
                    name="mode"
                    checked={config.mode === 0}
                    onChange={() => updateConfig({
                      ...config,
                      mode: 0
                    })}
                    className="form-radio h-5 w-5 text-blue-600"
                  />
                  <div className="ml-3">
                    <span className="text-gray-800 font-medium">Translation</span>
                    <p className="text-gray-500 text-sm mt-1">Recognize speech, translate, and send to VRChat</p>
                  </div>
                </label>
                
                <label className="flex items-center p-3 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="radio"
                    id="mode-transcribe"
                    name="mode"
                    checked={config.mode === 1}
                    onChange={() => updateConfig({
                      ...config,
                      mode: 1
                    })}
                    className="form-radio h-5 w-5 text-blue-600"
                  />
                  <div className="ml-3">
                    <span className="text-gray-800 font-medium">Transcription Only</span>
                    <p className="text-gray-500 text-sm mt-1">Only recognize and send speech without translation</p>
                  </div>
                </label>
              </div>
            </div>
            
            {/* Language Settings */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">Language Settings</h3>
              
              <div className="space-y-3">
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    id="omit-questionmark"
                    checked={config.language_settings.omit_questionmark}
                    onChange={(e) => updateConfig({
                      ...config,
                      language_settings: {
                        ...config.language_settings,
                        omit_questionmark: e.target.checked
                      }
                    })}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded"
                  />
                  <span className="ml-3 text-gray-800">
                    <span className="font-medium">Japanese:</span> Omit question marks (？)
                  </span>
                </label>
                
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    id="gender-change"
                    checked={config.language_settings.gender_change}
                    onChange={(e) => updateConfig({
                      ...config,
                      language_settings: {
                        ...config.language_settings,
                        gender_change: e.target.checked
                      }
                    })}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded"
                  />
                  <span className="ml-3 text-gray-800">
                    <span className="font-medium">English:</span> Apply gender changes to pronouns
                  </span>
                </label>
                
                {config.language_settings.gender_change && (
                  <div className="ml-8 mt-2 p-3 bg-blue-50 border-l-4 border-blue-400 rounded-r-md">
                    <div className="space-y-2">
                      <label className="flex items-center">
                        <input
                          type="radio"
                          id="gender-masculine"
                          name="gender-type"
                          checked={config.language_settings.gender_change_type === 0}
                          onChange={() => updateConfig({
                            ...config,
                            language_settings: {
                              ...config.language_settings,
                              gender_change_type: 0
                            }
                          })}
                          className="form-radio h-4 w-4 text-blue-600"
                        />
                        <span className="ml-2 text-gray-700">Make masculine (he/him)</span>
                      </label>
                      
                      <label className="flex items-center">
                        <input
                          type="radio"
                          id="gender-feminine"
                          name="gender-type"
                          checked={config.language_settings.gender_change_type === 1}
                          onChange={() => updateConfig({
                            ...config,
                            language_settings: {
                              ...config.language_settings,
                              gender_change_type: 1
                            }
                          })}
                          className="form-radio h-4 w-4 text-blue-600"
                        />
                        <span className="ml-2 text-gray-700">Make feminine (she/her)</span>
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Audio Settings */}
      {activeTab === 'audio' && (
        <div className="card p-5 animate-fade-in">
          <div className="space-y-6">
            {/* Microphone Selection */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">Microphone Selection</h3>
              
              {loadingMics ? (
                <div className="flex items-center justify-center py-4">
                  <div className="w-5 h-5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin mr-2"></div>
                  <span className="text-gray-600">Loading microphones...</span>
                </div>
              ) : availableMicrophones.length === 0 ? (
                <div className="p-3 bg-yellow-50 border-l-4 border-yellow-400 rounded-r-md text-yellow-700">
                  No microphones found or microphone access denied. Please check your browser permissions.
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Use system default option */}
                  <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                    <input
                      type="radio"
                      name="selected-mic"
                      checked={config.selected_microphone === null}
                      onChange={() => updateConfig({
                        ...config,
                        selected_microphone: null
                      })}
                      className="form-radio h-5 w-5 text-blue-600"
                    />
                    <div className="ml-3">
                      <span className="text-gray-800 font-medium">Use System Default</span>
                      <p className="text-gray-500 text-sm mt-1">Use the default microphone selected by your system</p>
                    </div>
                  </label>
                  
                  {/* Available microphones */}
                  {availableMicrophones.map((mic) => (
                    <label 
                      key={mic.deviceId} 
                      className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer"
                    >
                      <input
                        type="radio"
                        name="selected-mic"
                        checked={config.selected_microphone === mic.deviceId}
                        onChange={() => updateConfig({
                          ...config,
                          selected_microphone: mic.deviceId
                        })}
                        className="form-radio h-5 w-5 text-blue-600"
                      />
                      <div className="ml-3">
                        <span className="text-gray-800 font-medium">{getMicrophoneName(mic)}</span>
                        {mic.label && (
                          <p className="text-gray-500 text-xs mt-0.5 truncate max-w-md">{mic.label}</p>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
              
              <div className="mt-4">
                <button
                  onClick={() => {
                    setLoadingMics(true);
                    navigator.mediaDevices.getUserMedia({ audio: true })
                      .then(() => navigator.mediaDevices.enumerateDevices())
                      .then((devices) => {
                        const audioInputs = devices.filter(device => device.kind === 'audioinput');
                        setAvailableMicrophones(audioInputs);
                        setLoadingMics(false);
                      })
                      .catch((error) => {
                        console.error('Error refreshing microphones:', error);
                        setLoadingMics(false);
                      });
                  }}
                  className="px-3 py-1.5 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md text-sm font-medium flex items-center"
                >
                  <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh Microphones
                </button>
              </div>
              
              <p className="text-xs text-gray-500 mt-3">
                Note: Changing microphones will restart the speech recognition service.
              </p>
            </div>
          </div>
        </div>
      )}
      
      {/* VRChat Settings */}
      {activeTab === 'vrchat' && (
        <div className="card p-5 animate-fade-in">
          <div className="space-y-6">
            {/* Display Options */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">Display Options</h3>
              
              <div className="space-y-3">
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    id="translation-first"
                    checked={config.vrchat_settings.translation_first}
                    onChange={(e) => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        translation_first: e.target.checked
                      }
                    })}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded"
                  />
                  <span className="ml-3 text-gray-800">Show translation first</span>
                </label>
                
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    id="only-translation"
                    checked={config.vrchat_settings.only_translation}
                    onChange={(e) => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        only_translation: e.target.checked
                      }
                    })}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded"
                  />
                  <span className="ml-3 text-gray-800">Show only translation (hide original text)</span>
                </label>
                
                <div className="p-3 mt-2 bg-blue-50 border-l-4 border-blue-400 rounded-r-md">
                  <h4 className="font-medium text-blue-800">Display Format:</h4>
                  <p className="text-gray-600 text-sm mt-1">
                    {config.vrchat_settings.translation_first 
                      ? config.vrchat_settings.only_translation 
                        ? "Translation only" 
                        : "Translation (Original text)"
                      : config.vrchat_settings.only_translation
                        ? "Original text only"
                        : "Original text (Translation)"
                    }
                  </p>
                </div>
              </div>
            </div>
            
            {/* Behavior Settings */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">Behavior</h3>
              
              <div className="space-y-3">
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    id="disable-when-muted"
                    checked={config.vrchat_settings.disable_when_muted}
                    onChange={(e) => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        disable_when_muted: e.target.checked
                      }
                    })}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded"
                  />
                  <span className="ml-3 text-gray-800">Disable when muted in VRChat</span>
                </label>
                
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    id="typing-status"
                    checked={config.vrchat_settings.send_typing_status_while_talking}
                    onChange={(e) => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        send_typing_status_while_talking: e.target.checked
                      }
                    })}
                    className="form-checkbox h-5 w-5 text-blue-600 rounded"
                  />
                  <span className="ml-3 text-gray-800">Send typing status while talking</span>
                </label>
              </div>
            </div>
            
            {/* Chatbox Update Speed */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">Chatbox Update Speed</h3>
              
              <div className="space-y-3">
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="radio"
                    id="speed-slow"
                    name="speed"
                    checked={config.vrchat_settings.chatbox_update_speed === speed_presets.slow}
                    onChange={() => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        chatbox_update_speed: speed_presets.slow
                      }
                    })}
                    className="form-radio h-5 w-5 text-blue-600"
                  />
                  <div className="ml-3">
                    <span className="text-gray-800 font-medium">Slow</span>
                    <p className="text-gray-500 text-sm mt-1">Less chance of text cutoff (recommended)</p>
                  </div>
                </label>
                
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="radio"
                    id="speed-medium"
                    name="speed"
                    checked={config.vrchat_settings.chatbox_update_speed === speed_presets.medium}
                    onChange={() => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        chatbox_update_speed: speed_presets.medium
                      }
                    })}
                    className="form-radio h-5 w-5 text-blue-600"
                  />
                  <div className="ml-3">
                    <span className="text-gray-800 font-medium">Medium</span>
                    <p className="text-gray-500 text-sm mt-1">Balanced update speed</p>
                  </div>
                </label>
                
                <label className="flex items-center px-3 py-2 bg-white rounded-md border border-gray-200 hover:border-blue-300 transition-colors cursor-pointer">
                  <input
                    type="radio"
                    id="speed-fast"
                    name="speed"
                    checked={config.vrchat_settings.chatbox_update_speed === speed_presets.fast}
                    onChange={() => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        chatbox_update_speed: speed_presets.fast
                      }
                    })}
                    className="form-radio h-5 w-5 text-blue-600"
                  />
                  <div className="ml-3">
                    <span className="text-gray-800 font-medium">Fast</span>
                    <p className="text-gray-500 text-sm mt-1">Faster updates but may cut off text</p>
                  </div>
                </label>
              </div>
            </div>
            
            {/* Connection Settings */}
            <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
              <h3 className="font-semibold text-lg text-gray-800 mb-3">VRChat Connection</h3>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="osc-address" className="label">OSC Address</label>
                  <input
                    type="text"
                    id="osc-address"
                    value={config.vrchat_settings.osc_address}
                    onChange={(e) => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        osc_address: e.target.value
                      }
                    })}
                    className="input-field"
                    placeholder="127.0.0.1"
                  />
                </div>
                
                <div>
                  <label htmlFor="osc-port" className="label">OSC Port</label>
                  <input
                    type="number"
                    id="osc-port"
                    value={config.vrchat_settings.osc_port}
                    onChange={(e) => updateConfig({
                      ...config,
                      vrchat_settings: {
                        ...config.vrchat_settings,
                        osc_port: parseInt(e.target.value) || 9000
                      }
                    })}
                    className="input-field"
                    placeholder="9000"
                  />
                </div>
              </div>
              
              <p className="text-xs text-gray-500 mt-2">
                Default VRChat OSC settings are 127.0.0.1:9000. Only change if you know what you're doing.
              </p>
            </div>
          </div>
        </div>
      )}
      
    </div>
  );
};

export default Settings; 