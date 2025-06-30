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

// Global variables for detection queue and lock
let detectionQueue: string[] = [];
let lock = false;

// Global speech recognition instance to prevent multiple instances
let globalSpeechRecognizer: Recognizer | null = null;
let globalSRInitialized = false;

const VRCTalk: React.FC<VRCTalkProps> = ({ config, setConfig }) => {
  const [detecting, setDetecting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [recognitionActive, setRecognitionActive] = useState(true);
  const [vrcMuted, setVRCMuted] = useState(false);
  
  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [defaultMicrophone, setDefaultMicrophone] = useState("Initializing...");
  
  const [triggerUpdate, setTriggerUpdate] = useState(false);
  
  const [sourceLanguage, setSourceLanguage] = useState(config.source_language);
  const [targetLanguage, setTargetLanguage] = useState(config.target_language);
  const [isChangingLanguage, setIsChangingLanguage] = useState(false);

  // Use global speech recognizer to prevent multiple instances
  const [sr, setSr] = useState<Recognizer | null>(globalSpeechRecognizer);
  
  // Update config when language selections change
  useEffect(() => {
    // Keep track of the previous values for debugging
    const prevSourceLang = config.source_language;
    const prevTargetLang = config.target_language;
    
    const newConfig = {
      ...config,
      source_language: sourceLanguage,
      target_language: targetLanguage
    };
    setConfig(newConfig);
    saveConfig(newConfig);
    
    // Log language change details
    info(`[LANGUAGE] Language change detected: source=${prevSourceLang}->${sourceLanguage}, target=${prevTargetLang}->${targetLanguage}`);
    
    if (sr) {
      // Only handle source language changes here, as that affects speech recognition
      if (prevSourceLang !== sourceLanguage) {
        info(`[LANGUAGE] Changing source language to ${sourceLanguage}`);
        
        // Provide visual feedback that language change is in progress
        setSourceText("");
        setTranslatedText("");
        setDetecting(false);
        setIsChangingLanguage(true);
        
        // Reset the detection queue
        detectionQueue = [];
        
        // Apply the language change to the recognizer with a slight delay to let UI update
        setTimeout(() => {
          if (sr) {
            sr.set_lang(sourceLanguage);
            
            // Add small delay before allowing new detections to ensure complete transition
            setTimeout(() => {
              // Force trigger a state update to refresh detection state
              setTriggerUpdate(!triggerUpdate);
              setIsChangingLanguage(false);
            }, 1000);
          }
        }, 200);
      }
      // If only target language changed (not source), we don't need to restart recognition
      else if (prevTargetLang !== targetLanguage) {
        info(`[LANGUAGE] Only target language changed to ${targetLanguage}, no need to restart recognition`);
        setIsChangingLanguage(false);
      }
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
      // Check if we should stop recognition due to mute
      const shouldBeMuted = vrcMuted && config.vrchat_settings.disable_when_muted;
      
      // If the app should be muted, stop recognition
      if (shouldBeMuted) {
        info("[SR] Pausing recognition because VRChat is muted");
        sr.stop();
      } 
      // Otherwise, ensure recognition is running if it's not already
      else if (!sr.status()) {
        info("[SR] Starting/resuming recognition");
        sr.start();
      }
    } else {
      info("[SR] Stopping recognition by user request");
      sr.stop();
    }
  }, [recognitionActive, vrcMuted, config.vrchat_settings.disable_when_muted, sr]);
  
  // Translation processing loop
  useEffect(() => {
    const processTranslation = async () => {
      if (detectionQueue.length === 0 || lock) return;
      
      const text = detectionQueue[0].replace(/%/g, "%25");
      detectionQueue = detectionQueue.slice(1);
      
      lock = true;
      info(`[TRANSLATION] Starting translation. Queue length: ${detectionQueue.length}`);
      
      // Send typing indicator to VRChat
      try {
        await invoke("send_typing", { 
          address: config.vrchat_settings.osc_address, 
          port: `${config.vrchat_settings.osc_port}` 
        });
      } catch (e) {
        error(`[TRANSLATION] Error sending typing status: ${e}`);
        // Continue anyway, as this is not critical
      }
      
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
            
          // Build message with tags at ends e.g., [EN] text | translation [JP]
          const divider = ' | ';
          const srcTag = `[${sourceLanguage.split('-')[0].toUpperCase()}]`;
          const tgtTag = `[${targetLanguage.split('-')[0].toUpperCase()}]`;

          let messageFormat = `${srcTag} ${originalText}${divider}${finalTranslation} ${tgtTag}`;

          if (config.vrchat_settings.only_translation) {
            messageFormat = `${finalTranslation} ${tgtTag}`;
          } else if (config.vrchat_settings.translation_first) {
            messageFormat = `${tgtTag} ${finalTranslation}${divider}${originalText} ${srcTag}`;
          }
          
          try {
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
          } catch (sendError) {
            error(`[TRANSLATION] Error sending message to VRChat: ${sendError}`);
            // Continue anyway, we've already done the translation
          }
          
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
    // Only initialize if not already initialized globally
    if (globalSRInitialized && globalSpeechRecognizer) {
      info("[SR] Using existing global speech recognizer");
      setSr(globalSpeechRecognizer);
      
      // Force restart the global speech recognizer to ensure it's working
      info("[SR] Force restarting existing global speech recognizer after component remount");
      
      // First stop any existing recognition
      if (globalSpeechRecognizer.status()) {
        info("[SR] Stopping existing recognition before restart");
        globalSpeechRecognizer.stop();
      }
      
      // Then restart after a short delay
      setTimeout(() => {
        if (globalSpeechRecognizer && recognitionActive) {
          info("[SR] Executing restart of global speech recognizer");
          globalSpeechRecognizer.restart();
          
          // Double check that recognition is actually running after restart
          setTimeout(() => {
            if (globalSpeechRecognizer && recognitionActive && !globalSpeechRecognizer.status()) {
              info("[SR] Recognition still not running after restart, forcing start");
              globalSpeechRecognizer.start();
            }
          }, 1000);
        }
      }, 500);
      return;
    }
    
    info("[SR] Initializing new speech recognition");
    globalSRInitialized = true;
    
    // Listen for VRChat mute status
    const unlistenVrcMute = listen<boolean>("vrchat-mute", (event) => {
      info(`[OSC] Received VRChat mute status: ${event.payload}`);
      setVRCMuted(event.payload);

      // Explicitly handle unmute events when disable_when_muted is active
      if (sr && !event.payload && config.vrchat_settings.disable_when_muted && recognitionActive) {
        info("[OSC] VRChat unmuted while disable_when_muted is active. Resuming recognition...");
        // Use a short delay to ensure state updates properly
        setTimeout(() => {
          if (sr) {
            info("[OSC] Restarting recognition after unmute");
            sr.restart();
          }
        }, 300);
      }
    });
    
    // Listen for VRChat connection status
    const unlistenVrcStatus = listen<string>("vrchat-status", (event) => {
      info(`[OSC] VRChat connection status: ${event.payload}`);
      // You could update UI based on this status if needed
    });
    
    // Listen for VRChat errors
    const unlistenVrcError = listen<string>("vrchat-error", (event) => {
      error(`[OSC] VRChat error: ${event.payload}`);
      // You could show an error message to the user if needed
    });
    
    // Start VRChat listener in Rust backend
    invoke("start_vrc_listener").catch(e => {
      error(`[OSC] Error starting VRChat listener: ${e}`);
    });
    
    // Microphone detection with a fallback for when labels aren't immediately available
    let micDetectionAttempts = 0;
    const maxAttempts = 5;
    
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
            
            if (defaultInput) {
              // Extract mic name from format "Device name (identifier)"
              const match = defaultInput.match(/^(.*?)(\s+\([^)]+\))?$/);
              const micName = match ? match[1] : defaultInput;
              setDefaultMicrophone(micName);
            } else {
              // Increment attempt counter - if microphone is working but we can't get the label
              micDetectionAttempts++;
              if (micDetectionAttempts >= maxAttempts && defaultMicrophone === "Initializing...") {
                // After several attempts, just display "Microphone Active" if speech recognition is working
                info("[MEDIA] Could not get microphone label after multiple attempts. Setting generic label.");
                setDefaultMicrophone("Microphone Active");
              }
            }
          }
        })
        .catch((err) => {
          error(`[MEDIA] Error accessing media devices: ${err}`);
          micDetectionAttempts++;
          if (micDetectionAttempts >= maxAttempts && defaultMicrophone === "Initializing...") {
            // After several attempts, just display "Microphone Active" if speech recognition is working
            setDefaultMicrophone("Microphone Active");
          }
        });
    }, 1000);
    
    // Initialize speech recognition
    const recognizer = new WebSpeech(config.source_language, config.selected_microphone);
    globalSpeechRecognizer = recognizer;
    setSr(recognizer);
      
    // Set up the result handler
    recognizer.onResult((result: string, isFinal: boolean) => {
      info(`[SR] Received speech: Final=${isFinal}, Text=${result.substring(0, 30)}${result.length > 30 ? '...' : ''}`);
      
      // If we receive speech but microphone still shows initializing, assume it's working
      if (defaultMicrophone === "Initializing...") {
        info("[MEDIA] Received speech while microphone showed initializing. Setting status to Microphone Active.");
        setDefaultMicrophone("Microphone Active");
      }
      
      // Send typing status if configured
      if (config.vrchat_settings.send_typing_status_while_talking || config.mode === 1) {
        invoke("send_typing", { 
          address: config.vrchat_settings.osc_address, 
          port: `${config.vrchat_settings.osc_port}` 
        });
      }
      
      // Update UI with current speech
      setSourceText(result);
      setDetecting(!isFinal);

      // When we get a final transcript, queue it for translation (in translation mode)
      if (isFinal && config.mode === 0) {
        detectionQueue.push(result);
        // Force the translation processing loop to run ASAP
        setTriggerUpdate(prev => !prev);
      }
    });
    
    // Start recognition
    recognizer.start();
    info("[SR] Speech recognition started");
    
    return () => {
      clearInterval(microphoneCheckInterval);
      unlistenVrcMute.then(unlisten => unlisten());
      unlistenVrcStatus.then(unlisten => unlisten());
      unlistenVrcError.then(unlisten => unlisten());
      
      // Don't destroy the global speech recognizer, just stop it temporarily
      if (sr && sr === globalSpeechRecognizer) {
        info("[SR] Pausing speech recognition on component unmount (keeping global instance)");
        // Don't call sr.stop() here to avoid conflicts when remounting
      }
    };
  }, []); // Run on every component mount/unmount
  
  // Handle source language change
  const handleSourceLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    info(`[LANGUAGE] User changing source language to: ${newLang}`);
    
    // Show change is in progress
    setIsChangingLanguage(true);
    setSourceText("");
    setTranslatedText("");
    
    // Force reset recognition
    if (sr) {
      try {
        sr.stop();
      } catch (e) {
        error(`[LANGUAGE] Error stopping recognition during language change: ${e}`);
      }
    }
    
    // Apply the language change with a slight delay
    setTimeout(() => {
      setSourceLanguage(newLang);
    }, 200);
  };
  
  // Handle target language change
  const handleTargetLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    info(`[LANGUAGE] User changing target language to: ${newLang}`);
    
    // Only show loading indicator if we're in translation mode
    if (config.mode === 0) {
      setIsChangingLanguage(true);
    }
    
    setTargetLanguage(newLang);
  };
  
  // Toggle recognition
  const toggleRecognition = () => {
    setRecognitionActive(!recognitionActive);
  };

  // Swap languages
  const swapLanguages = () => {
    info("[LANGUAGE] User swapping languages");
    // Show language change in progress
    setIsChangingLanguage(true);
    
    // Clear any existing text
    setSourceText("");
    setTranslatedText("");
    setDetecting(false);
    
    // Reset the detection queue
    detectionQueue = [];
    
    const tempSourceLang = sourceLanguage;
    const tempTargetLang = targetLanguage;
    
    // 1. Handle source to target (e.g. "en-US" to "en")
    let newTargetLang = tempSourceLang;
    
    // If source has a region specifier (e.g., "en-US"), look for generic version in target
    if (tempSourceLang.includes('-')) {
      const baseLang = tempSourceLang.split('-')[0];
      const genericTarget = langTo.find(l => l.code === baseLang);
      if (genericTarget) {
        newTargetLang = genericTarget.code;
      }
    }
    
    // 2. Handle target to source (e.g. "en" to "en-US")
    let newSourceLang = tempTargetLang;
    
    // If target is a generic language without region (e.g., "en")
    // Look for a region-specific version in source languages (prefer US variants)
    if (!tempTargetLang.includes('-')) {
      // First try to find the US variant (e.g., "en-US" for "en")
      const usVariant = langSource.find(l => l.code === `${tempTargetLang}-US`);
      if (usVariant) {
        newSourceLang = usVariant.code;
      } else {
        // Then try any variant that starts with the target language code
        const anyVariant = langSource.find(l => l.code.startsWith(`${tempTargetLang}-`));
        if (anyVariant) {
          newSourceLang = anyVariant.code;
        } else {
          // If no variants found, look for exact match
          const exactMatch = langSource.find(l => l.code === tempTargetLang);
          if (exactMatch) {
            newSourceLang = exactMatch.code;
          }
        }
      }
    }
    
    info(`[LANGUAGE] Swapping languages from ${tempSourceLang} -> ${tempTargetLang} to ${newSourceLang} -> ${newTargetLang}`);
    
    // Apply the changes in sequence with a slight delay between them
    // First set the target language
    setTargetLanguage(newTargetLang);
    
    // Then set the source language after a small delay
    setTimeout(() => {
      setSourceLanguage(newSourceLang);
      
      // Force a complete reset of the speech recognition after swap is complete
      if (sr) {
        setTimeout(() => {
          if (sr) {
            info("[LANGUAGE] Forcing speech recognizer restart after language swap");
            sr.stop();
            setTimeout(() => {
              if (sr && recognitionActive) {
                sr.start();
              }
            }, 500);
          }
        }, 500);
      }
    }, 300);
  };

  // UI component return
  return (
    <div className="space-y-3">
      {/* Status Header */}
      <div className="modern-card animate-slide-up">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center space-y-3 lg:space-y-0">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">
              Voice Translation
            </h2>
            <p className="text-sm text-white/70">
              Translating from{' '}
              <span className="font-semibold text-blue-300">
                {langSource[findLangSourceIndex(sourceLanguage)]?.name || sourceLanguage}
              </span>
              {' '}to{' '}
              <span className="font-semibold text-purple-300">
                {langTo[findLangToIndex(targetLanguage)]?.name || targetLanguage}
              </span>
            </p>
          </div>
          
          {/* Status Indicators */}
          <div className="flex flex-wrap items-center gap-4">
            {/* Microphone Status */}
            <div className="flex items-center space-x-3 bg-white/5 rounded-xl px-4 py-2">
              <div className="relative">
                <div className={`status-dot ${recognitionActive ? 'status-active' : 'status-inactive'}`}></div>
                {recognitionActive && detecting && (
                  <div className="mic-pulse"></div>
                )}
              </div>
              <div className="text-sm">
                <div className="text-white font-medium">Microphone</div>
                <div className="text-white/60">{defaultMicrophone}</div>
              </div>
            </div>
            
            {/* VRChat Status */}
            <div className="flex items-center space-x-3 bg-white/5 rounded-xl px-4 py-2">
              <div className={`status-dot ${vrcMuted ? 'status-warning' : 'status-active'}`}></div>
              <div className="text-sm">
                <div className="text-white font-medium">VRChat</div>
                <div className="text-white/60">{vrcMuted ? 'Muted' : 'Connected'}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Language Selection */}
      <div className="modern-card animate-slide-up animate-delay-100">
        <h3 className="text-lg font-semibold text-white mb-4">Language Settings</h3>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4 relative">
          {/* Source Language */}
          <div className="space-y-3">
            <label className="block text-xs font-medium text-white/80">
              Source Language (Speech Input)
            </label>
            <div className="relative">
              <select 
                value={sourceLanguage}
                onChange={handleSourceLanguageChange}
                className="select-modern"
                disabled={isChangingLanguage}
              >
                {langSource.map((lang, index) => (
                  <option key={`source-${index}`} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          {/* Swap Button */}
          <div className="absolute left-1/2 top-1/2 transform -translate-x-1/2 -translate-y-1/2 z-10 hidden lg:block">
            <button 
              onClick={swapLanguages}
              className="swap-button"
              disabled={isChangingLanguage}
              title="Swap Languages"
            >
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>
          
          {/* Target Language */}
          <div className="space-y-3">
            <label className="block text-xs font-medium text-white/80">
              Target Language (Translation Output)
            </label>
            <div className="relative">
              <select 
                value={targetLanguage}
                onChange={handleTargetLanguageChange}
                className="select-modern"
                disabled={isChangingLanguage}
              >
                {langTo.map((lang, index) => (
                  <option key={`target-${index}`} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          {/* Mobile Swap Button */}
          <div className="flex justify-center lg:hidden">
            <button 
              onClick={swapLanguages}
              className="btn-modern flex items-center space-x-2"
              disabled={isChangingLanguage}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              <span>Swap Languages</span>
            </button>
          </div>
        </div>
      </div>

      {/* Speech Recognition Control */}
      <div className="modern-card animate-slide-up animate-delay-200">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-semibold text-white">Speech Recognition</h3>
          <button 
            onClick={toggleRecognition} 
            className={`btn-modern flex items-center space-x-2 ${
              recognitionActive 
                ? 'btn-danger' 
                : 'btn-success'
            }`}
            disabled={isChangingLanguage}
          >
            {recognitionActive ? (
              <>
                <div className="relative">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                  </svg>
                  {detecting && (
                    <div className="absolute inset-0 rounded-full border-2 border-white animate-ping opacity-75"></div>
                  )}
                </div>
                <span>Pause Recognition</span>
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>Start Recognition</span>
              </>
            )}
          </button>
        </div>

        {/* Source Text Display */}
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-white">Detected Speech</h4>
              <div className="flex items-center space-x-2">
                {detecting && (
                  <div className="flex items-center space-x-2 text-sm text-yellow-300">
                    <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></div>
                    <span>Listening...</span>
                  </div>
                )}
                {isChangingLanguage && (
                  <div className="flex items-center space-x-2 text-sm text-blue-300">
                    <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></div>
                    <span>Changing Language...</span>
                  </div>
                )}
              </div>
            </div>
            <div className={`text-display-modern ${detecting || isChangingLanguage ? 'text-display-active' : ''}`}>
              <div className="text-white text-sm leading-relaxed">
                {sourceText || (
                  <span className="text-white/50 italic">
                    {isChangingLanguage ? 'Changing language...' : 'Waiting for speech...'}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Translated Text Display */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-medium text-white">Translation</h4>
              {translating && (
                <div className="flex items-center space-x-2 text-sm text-purple-300">
                  <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse"></div>
                  <span>Translating...</span>
                </div>
              )}
            </div>
            <div className={`text-display-modern ${translating ? 'text-display-active' : ''}`}>
              <div className="text-white text-sm leading-relaxed">
                {translatedText || (
                  <span className="text-white/50 italic">
                    {isChangingLanguage ? 'Changing language...' : 'Translation will appear here...'}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VRCTalk;