import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { info, error } from '@tauri-apps/plugin-log';

import { Recognizer } from '../recognizers/recognizer';
import { WebSpeech } from '../recognizers/WebSpeech';
import translateGT from '../translators/google_translate';
import { Config, saveConfig } from '../utils/config';
import { calculateMinWaitTime, langSource, langTo, findLangSourceIndex, findLangToIndex } from '../utils/constants';

interface VRCTalkProps {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
}

let sr: Recognizer | null = null;
let detectionQueue: string[] = [];
let lock = false;

const VRCTalk: React.FC<VRCTalkProps> = ({ config, setConfig }) => {
  const [detecting, setDetecting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [recognitionActive, setRecognitionActive] = useState(true);
  const [vrcMuted, setVRCMuted] = useState(false);
  
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [defaultMicrophone, setDefaultMicrophone] = useState("Initializing...");
  const [lastDefaultMicrophone, setLastDefaultMicrophone] = useState("");
  
  const [triggerUpdate, setTriggerUpdate] = useState(false);
  
  const [sourceLanguage, setSourceLanguage] = useState(config.source_language);
  const [targetLanguage, setTargetLanguage] = useState(config.target_language);
  
  // Update config when language selections change
  useEffect(() => {
    const newConfig = {
      ...config,
      source_language: sourceLanguage,
      target_language: targetLanguage
    };
    setConfig(newConfig);
    saveConfig(newConfig);
    
    if (sr) {
      info(`[LANGUAGE] Changing source language to ${sourceLanguage}`);
      sr.set_lang(sourceLanguage);
    }
  }, [sourceLanguage, targetLanguage]);
  
  // Handle recognition status based on VRC mute status
  useEffect(() => {
    info(`[SR] Recognition status=${recognitionActive} - VRC Muted=${vrcMuted} - Disable when muted=${config.vrchat_settings.disable_when_muted}`);
    
    if (!sr) {
      info("[SR] Speech recognizer not initialized yet");
      return;
    }
    
    if (recognitionActive) {
      if (vrcMuted && config.vrchat_settings.disable_when_muted) {
        info("[SR] Pausing recognition because VRChat is muted");
        sr.stop();
      } else if (!sr.status()) {
        info("[SR] Starting recognition");
        sr.start();
      }
    } else {
      info("[SR] Stopping recognition by user request");
      sr.stop();
    }
  }, [recognitionActive, vrcMuted, config.vrchat_settings.disable_when_muted]);
  
  // Translation processing loop
  useEffect(() => {
    const processTranslation = async () => {
      if (detectionQueue.length === 0 || lock) return;
      
      const text = detectionQueue[0].replace(/%/g, "%25");
      detectionQueue = detectionQueue.slice(1);
      
      lock = true;
      info(`[TRANSLATION] Starting translation. Queue length: ${detectionQueue.length}`);
      
      // Send typing indicator to VRChat
      await invoke("send_typing", { 
        address: config.vrchat_settings.osc_address, 
        port: `${config.vrchat_settings.osc_port}` 
      });
      
      let attempts = 3;
      while (attempts > 0) {
        info(`[TRANSLATION] Attempt ${4 - attempts}`);
        try {
          setTranslating(true);
          
          // Get translation
          const translatedResult = await translateGT(text, sourceLanguage, targetLanguage);
          info("[TRANSLATION] Translation succeeded!");
          
          // Apply gender changes if needed
          let finalTranslation = translatedResult;
          if (config.language_settings.gender_change && targetLanguage === "en") {
            info("[TRANSLATION] Applying gender changes...");
            
            if (config.language_settings.gender_change_type === 0) {
              // Make masculine
              finalTranslation = finalTranslation.replace(/\bshe\b/g, "he")
                .replace(/\bShe\b/g, "He")
                .replace(/\bher\b/g, "him")
                .replace(/\bHer\b/g, "Him");
            } else {
              // Make feminine
              finalTranslation = finalTranslation.replace(/\bhe\b/g, "she")
                .replace(/\bHe\b/g, "She")
                .replace(/\bhis\b/g, "her")
                .replace(/\bHis\b/g, "Her")
                .replace(/\bhim\b/g, "her")
                .replace(/\bHim\b/g, "Her")
                .replace(/\bhe's\b/g, "she's")
                .replace(/\bHe's\b/g, "She's");
            }
          }
          
          setTranslatedText(finalTranslation);
          setTranslating(false);
          
          // Send to VRChat
          info("[TRANSLATION] Sending message to VRChat chatbox");
          const originalText = sourceLanguage === "ja" && config.language_settings.omit_questionmark 
            ? text.replace(/？/g, "") 
            : text;
            
          const messageFormat = config.vrchat_settings.translation_first 
            ? `${finalTranslation}${config.vrchat_settings.only_translation ? '' : ` (${originalText})`}`
            : `${originalText}${config.vrchat_settings.only_translation ? '' : ` (${finalTranslation})`}`;
          
          await invoke("send_message", {
            address: config.vrchat_settings.osc_address,
            port: `${config.vrchat_settings.osc_port}`,
            msg: messageFormat
          });
          
          // Wait for chatbox to process
          await new Promise(r => setTimeout(r, calculateMinWaitTime(
            finalTranslation, 
            config.vrchat_settings.chatbox_update_speed
          )));
          
          attempts = 0;
        } catch (e) {
          error(`[TRANSLATION] Error during translation: ${e}`);
          attempts--;
        }
        
        if (attempts <= 0) break;
      }
      
      lock = false;
    };
    
    processTranslation();
    
    // Trigger periodic updates to check the queue
    const timer = setTimeout(() => {
      setTriggerUpdate(!triggerUpdate);
    }, 100);
    
    return () => clearTimeout(timer);
  }, [triggerUpdate]);
  
  // Initialize speech recognition and VRC mute listener
  useEffect(() => {
    // Listen for VRChat mute status
    const unlistenVrcMute = listen<boolean>("vrchat-mute", (event) => {
      info(`[OSC] Received VRChat mute status: ${event.payload}`);
      setVRCMuted(event.payload);
    });
    
    // Start VRChat listener in Rust backend
    invoke("start_vrc_listener");
    
    // Check available microphones
    const microphoneCheckInterval = setInterval(() => {
      navigator.mediaDevices.enumerateDevices()
        .then((devices) => {
          const audioInputs = devices.filter(device => device.kind === "audioinput");
          if (audioInputs.length > 0) {
            // If we have a selected microphone ID in config, use that one
            let selectedMic;
            if (config.selected_microphone) {
              selectedMic = audioInputs.find(device => device.deviceId === config.selected_microphone);
            }
            
            // If no specific mic is selected or it's not found, use the default
            const micToUse = selectedMic || audioInputs[0];
            const defaultInput = micToUse.label;
            
            // Extract mic name from format "Device name (identifier)"
            const match = defaultInput.match(/^(.*?)(\s+\([^)]+\))?$/);
            const micName = match ? match[1] : defaultInput;
            setDefaultMicrophone(micName);
          }
        })
        .catch((err) => {
          error(`[MEDIA] Error accessing media devices: ${err}`);
        });
    }, 1000);
    
    // Initialize speech recognition
    if (!sr) {
      info(`[SR] Initializing speech recognition with language ${config.source_language}`);
      sr = new WebSpeech(config.source_language, config.selected_microphone);
      
      // Set up the result handler
      sr.onResult((result: string, isFinal: boolean) => {
        info(`[SR] Received speech: Final=${isFinal}, Text=${result.substring(0, 30)}${result.length > 30 ? '...' : ''}`);
        
        // Send typing status if configured
        if (config.vrchat_settings.send_typing_status_while_talking || config.mode === 1) {
          invoke("send_typing", { 
            address: config.vrchat_settings.osc_address, 
            port: `${config.vrchat_settings.osc_port}` 
          });
        }
        
        setSourceText(result);
        setDetecting(!isFinal);
      });
      
      // Start recognition
      sr.start();
      info("[SR] Speech recognition started");
    }
    
    return () => {
      clearInterval(microphoneCheckInterval);
      unlistenVrcMute.then(unlisten => unlisten());
    };
  }, []);
  
  // Handle changes in microphone
  useEffect(() => {
    if (defaultMicrophone === "Initializing...") return;
    
    info(`[MEDIA] Current microphone: ${defaultMicrophone}`);
    
    if (lastDefaultMicrophone === "") {
      setLastDefaultMicrophone(defaultMicrophone);
      return;
    }
    
    if (lastDefaultMicrophone !== defaultMicrophone) {
      info("[MEDIA] Microphone changed, reloading...");
      window.location.reload();
    }
  }, [defaultMicrophone]);
  
  // Process detected speech
  useEffect(() => {
    info(`[DETECTION] Status: Detecting=${detecting}, Text length=${sourceText.length}`);
    
    if (!detecting && sourceText.length > 0) {
      if (config.mode === 0) { // Translation mode
        const processedText = sourceLanguage === "ja" && config.language_settings.omit_questionmark
          ? sourceText.replace(/？/g, "")
          : sourceText;
          
        detectionQueue = [...detectionQueue, processedText];
        info(`[DETECTION] Added to translation queue. Queue length: ${detectionQueue.length}`);
      } else { // Transcription only mode
        info(`[DETECTION] Sending transcription directly to VRChat`);
        invoke("send_message", { 
          address: config.vrchat_settings.osc_address, 
          port: `${config.vrchat_settings.osc_port}`, 
          msg: sourceLanguage === "ja" && config.language_settings.omit_questionmark
            ? sourceText.replace(/？/g, "")
            : sourceText 
        });
      }
    }
  }, [detecting, sourceText]);
  
  // Effect for handling changes to selected microphone in config
  useEffect(() => {
    if (sr && config.selected_microphone !== undefined) {
      info(`[SR] Selected microphone changed to: ${config.selected_microphone || 'default'}`);
      sr.set_microphone(config.selected_microphone);
    }
  }, [config.selected_microphone]);
  
  // Handle source language change
  const handleSourceLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSourceLanguage(e.target.value);
  };
  
  // Handle target language change
  const handleTargetLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setTargetLanguage(e.target.value);
  };
  
  // Toggle recognition
  const toggleRecognition = () => {
    setRecognitionActive(!recognitionActive);
  };

  // Swap languages
  const swapLanguages = () => {
    const tempLang = sourceLanguage;
    
    // 1. Handle source to target (e.g. "en-US" to "en")
    let newTargetLang = tempLang;
    
    // If source has a region specifier (e.g., "en-US"), look for generic version in target
    if (tempLang.includes('-')) {
      const baseLang = tempLang.split('-')[0];
      const genericTarget = langTo.find(l => l.code === baseLang);
      if (genericTarget) {
        newTargetLang = genericTarget.code;
      }
    }
    
    // 2. Handle target to source (e.g. "en" to "en-US")
    let newSourceLang = targetLanguage;
    
    // If target is a generic language without region (e.g., "en")
    // Look for a region-specific version in source languages (prefer US variants)
    if (!targetLanguage.includes('-')) {
      // First try to find the US variant (e.g., "en-US" for "en")
      const usVariant = langSource.find(l => l.code === `${targetLanguage}-US`);
      if (usVariant) {
        newSourceLang = usVariant.code;
      } else {
        // Then try any variant that starts with the target language code
        const anyVariant = langSource.find(l => l.code.startsWith(`${targetLanguage}-`));
        if (anyVariant) {
          newSourceLang = anyVariant.code;
        } else {
          // If no variants found, look for exact match
          const exactMatch = langSource.find(l => l.code === targetLanguage);
          if (exactMatch) {
            newSourceLang = exactMatch.code;
          }
        }
      }
    }
    
    // Apply the changes
    setSourceLanguage(newSourceLang);
    setTargetLanguage(newTargetLang);
  };

  // UI component return
  return (
    <div className="flex flex-col space-y-4">
      {/* Header section with status indicators */}
      <div className="card p-4 animate-slide-up">
        <div className="flex flex-col md:flex-row justify-between items-center md:space-x-4 space-y-2 md:space-y-0">
          <div>
            <h2 className="text-xl font-bold text-gray-800 mb-0.5">VRC Talk</h2>
            <p className="text-gray-600 text-sm">Translating from <span className="font-medium">{langSource[findLangSourceIndex(sourceLanguage)].name}</span> to <span className="font-medium">{langTo[findLangToIndex(targetLanguage)].name}</span></p>
          </div>
          
          <div className="flex items-center space-x-4">
            {/* Microphone status */}
            <div className="flex items-center">
              <div className={`w-2.5 h-2.5 rounded-full mr-2 ${recognitionActive ? 'bg-green-500' : 'bg-red-500'}`}></div>
              <span className="text-sm text-gray-700">{defaultMicrophone}</span>
            </div>
            
            {/* VRChat connection status */}
            <div className="flex items-center">
              <div className={`w-2.5 h-2.5 rounded-full mr-2 ${vrcMuted ? 'bg-yellow-500' : 'bg-green-500'}`}></div>
              <span className="text-sm text-gray-700">VRChat {vrcMuted ? 'Muted' : 'Connected'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Language Selection */}
      <div className="card p-4 animate-slide-up animate-delay-100">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative">
          <div>
            <label htmlFor="sourceLanguage" className="label">Source Language</label>
            <div className="relative">
              <select 
                id="sourceLanguage" 
                value={sourceLanguage}
                onChange={handleSourceLanguageChange}
                className="select-field appearance-none pr-10"
              >
                {langSource.map((lang, index) => (
                  <option key={`source-${index}`} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>
          
          {/* Swap languages button */}
          <div className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10 hidden md:block">
            <button 
              onClick={swapLanguages}
              className="bg-blue-500 hover:bg-blue-600 text-white rounded-full p-2 shadow-lg transition-all duration-200 hover:scale-110"
              title="Swap Languages"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>
          
          <div>
            <label htmlFor="targetLanguage" className="label">Target Language</label>
            <div className="relative">
              <select 
                id="targetLanguage" 
                value={targetLanguage}
                onChange={handleTargetLanguageChange}
                className="select-field appearance-none pr-10"
              >
                {langTo.map((lang, index) => (
                  <option key={`target-${index}`} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
              <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
          </div>
          
          {/* Mobile swap button */}
          <div className="flex justify-center mt-2 md:hidden">
            <button 
              onClick={swapLanguages}
              className="bg-blue-500 hover:bg-blue-600 text-white rounded-full p-2 shadow-lg transition-all duration-200 hover:scale-110 flex items-center"
              title="Swap Languages"
            >
              <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              Swap Languages
            </button>
          </div>
        </div>
      </div>

      {/* Speech Recognition UI */}
      <div className="card p-4 animate-slide-up animate-delay-200">
        <div className="flex justify-between items-center mb-3">
          <h3 className="text-lg font-semibold text-gray-800">Speech Recognition</h3>
          <button 
            onClick={toggleRecognition} 
            className={`flex items-center px-3 py-1.5 rounded-md font-medium transition-all duration-300 ${
              recognitionActive 
                ? 'bg-red-500 hover:bg-red-600 text-white' 
                : 'bg-green-500 hover:bg-green-600 text-white'
            }`}
          >
            {recognitionActive ? (
              <>
                <span className="relative mr-2">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                  </svg>
                  {detecting && (
                    <span className="absolute inset-0 rounded-full border-2 border-white animate-ping opacity-75"></span>
                  )}
                </span>
                Pause Recognition
              </>
            ) : (
              <>
                <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Start Recognition
              </>
            )}
          </button>
        </div>

        {/* Source Text Display */}
        <div className="mb-3">
          <div className="flex items-center mb-1">
            <h4 className="text-sm font-medium text-gray-700">Detected Speech</h4>
            {detecting && (
              <div className="ml-2 status-processing">
                <div className="mr-1 h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse"></div>
                Listening
              </div>
            )}
          </div>
          <div className={`text-display relative overflow-hidden ${detecting ? 'text-display-active' : ''}`}>
            <div key={sourceText} className={`transition-all duration-300 ${sourceText ? 'animate-slide-up' : ''}`}>
              {sourceText || (
                <span className="text-gray-400 italic">Waiting for speech...</span>
              )}
            </div>
            {detecting && (
              <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-green-400 via-blue-500 to-green-400 shimmer"></div>
            )}
          </div>
        </div>

        {/* Translated Text Display */}
        <div>
          <div className="flex items-center mb-1">
            <h4 className="text-sm font-medium text-gray-700">Translated Text</h4>
            {translating && (
              <div className="ml-2 status-processing">
                <div className="mr-1 h-1.5 w-1.5 rounded-full bg-yellow-500 animate-pulse"></div>
                Translating
              </div>
            )}
          </div>
          <div className={`text-display relative overflow-hidden ${translating ? 'text-display-active' : ''}`}>
            <div key={translatedText} className={`transition-all duration-500 ${translatedText ? 'animate-slide-up' : ''}`}>
              {translatedText || (
                <span className="text-gray-400 italic">Translation will appear here...</span>
              )}
            </div>
            {translating && (
              <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-blue-400 via-purple-500 to-blue-400 shimmer"></div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default VRCTalk; 