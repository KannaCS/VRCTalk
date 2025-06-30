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
  const [lastDefaultMicrophone, setLastDefaultMicrophone] = useState("");
  
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
            
          const messageFormat = config.vrchat_settings.translation_first 
            ? `${finalTranslation}${config.vrchat_settings.only_translation ? '' : ` (${originalText})`}`
            : `${originalText}${config.vrchat_settings.only_translation ? '' : ` (${finalTranslation})`}`;
          
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
      
      setSourceText(result);
      setDetecting(!isFinal);
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
  
  // Improve the speech recognizer restart logic when returning from settings tab
  useEffect(() => {
    if (sr && recognitionActive) {
      info(`[SR] Recognition check - active: ${recognitionActive}, status: ${sr.status()}`);
      
      if (!sr.status()) {
        info("[SR] Starting/resuming recognition");
        
        // First ensure any previous instances are fully stopped
        try {
          sr.stop();
          // Short delay to ensure clean state
          setTimeout(() => {
            if (sr && recognitionActive) {
              info("[SR] Starting recognition after delay");
              sr.start();
            }
          }, 300);
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          error(`[SR] Error restarting recognition: ${errorMessage}`);
          
          // Try to reinitialize if we encounter errors
          setTimeout(() => {
            if (sr && recognitionActive) {
              info("[SR] Reinitializing speech recognition after error");
              sr.restart();
            }
          }, 500);
        }
      } else {
        info("[SR] Speech recognition already running");
      }
    } else if (sr && !recognitionActive) {
      info("[SR] Recognition should be inactive, ensuring it's stopped");
      if (sr.status()) {
        sr.stop();
      }
    }
  }, [sr, recognitionActive]);
  
  // Handle changes in microphone
  useEffect(() => {
    if (defaultMicrophone === "Initializing..." || defaultMicrophone === "Microphone Active") return;
    
    info(`[MEDIA] Current microphone: ${defaultMicrophone}`);
    
    if (lastDefaultMicrophone === "") {
      setLastDefaultMicrophone(defaultMicrophone);
      return;
    }
    
    // Log microphone changes but don't automatically reload
    // The global speech recognizer should handle microphone changes gracefully
    if (lastDefaultMicrophone !== defaultMicrophone) {
      info(`[MEDIA] Microphone changed from "${lastDefaultMicrophone}" to "${defaultMicrophone}"`);
      setLastDefaultMicrophone(defaultMicrophone);
      
      // Instead of reloading, just restart the speech recognition if needed
      if (sr && recognitionActive) {
        info("[MEDIA] Restarting speech recognition due to microphone change");
        setTimeout(() => {
          if (sr) {
            sr.restart();
          }
        }, 500);
      }
    }
  }, [defaultMicrophone]);
  
  // Process detected speech
  useEffect(() => {
    if (!sr || isChangingLanguage) return; // Skip processing while language is changing
    
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
        const messageToSend = sourceLanguage === "ja" && config.language_settings.omit_questionmark
          ? sourceText.replace(/？/g, "")
          : sourceText;
          
        invoke("send_message", { 
          address: config.vrchat_settings.osc_address, 
          port: `${config.vrchat_settings.osc_port}`, 
          msg: messageToSend 
        }).catch(e => {
          error(`[DETECTION] Error sending message to VRChat: ${e}`);
        });
      }
    }
  }, [detecting, sourceText]);
  
  // Effect for handling changes to selected microphone in config
  useEffect(() => {
    if (sr && config.selected_microphone !== undefined) {
      info(`[SR] Selected microphone changed to: ${config.selected_microphone || 'default'}`);
      
      // Log the current available microphones for debugging
      navigator.mediaDevices.enumerateDevices()
        .then(devices => {
          const audioInputs = devices.filter(device => device.kind === 'audioinput');
          if (audioInputs.length > 0) {
            const micList = audioInputs.map(device => 
              `${device.label || 'Unnamed device'} (${device.deviceId.substring(0, 8)}...)`
            ).join(', ');
            info(`[SR] Available microphones: ${micList}`);
            
            // Check if selected microphone is in the list
            if (config.selected_microphone) {
              const found = audioInputs.some(device => device.deviceId === config.selected_microphone);
              if (!found) {
                error(`[SR] Warning: Selected microphone ${config.selected_microphone.substring(0, 8)}... not found in available devices`);
              }
            }
          } else {
            error('[SR] No audio input devices found');
          }
        })
        .catch(e => {
          error(`[SR] Error enumerating media devices: ${e instanceof Error ? e.message : String(e)}`);
        });
      
      sr.set_microphone(config.selected_microphone);
    }
  }, [config.selected_microphone, sr]);
  
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

  // Effect for handling changes to the disable_when_muted setting
  useEffect(() => {
    info(`[CONFIG] disable_when_muted changed to ${config.vrchat_settings.disable_when_muted}`);
    
    // If disable_when_muted was just turned off and we're currently muted in VRChat,
    // we need to explicitly restart recognition
    if (!config.vrchat_settings.disable_when_muted && vrcMuted && recognitionActive && sr) {
      info("[CONFIG] disable_when_muted turned off while VRChat is muted. Resuming recognition...");
      setTimeout(() => {
        if (sr) {
          sr.restart();
        }
      }, 300); // Short delay to ensure state updates properly
    }
  }, [config.vrchat_settings.disable_when_muted, vrcMuted, recognitionActive, sr]);

  // Force restart recognition after language changes
  useEffect(() => {
    // Skip initial render
    if (!sr) return;
    
    // Reset recognition when the component language state changes
    // This effect runs after the language props are updated
    info(`[LANGUAGE_RESET] Ensuring proper recognition state after language update: ${sourceLanguage}`);
    
    // Brief pause to let the system stabilize
    const timer = setTimeout(() => {
      if (sr) {
        // First ensure recognition is stopped
        try {
          sr.stop();
        } catch (e) {
          error(`[LANGUAGE_RESET] Error stopping recognition: ${e}`);
        }
        
        // Then restart if it should be active
        setTimeout(() => {
          if (sr && recognitionActive) {
            info("[LANGUAGE_RESET] Restarting recognition after language change");
            try {
              sr.start();
            } catch (e) {
              error(`[LANGUAGE_RESET] Error restarting recognition: ${e}`);
              
              // As a last resort, try one more restart
              setTimeout(() => {
                if (sr && recognitionActive) {
                  try {
                    sr.restart();
                  } catch (finalError) {
                    error(`[LANGUAGE_RESET] Final error restarting recognition: ${finalError}`);
                  }
                }
              }, 500);
            }
          }
          
          // Clear language change status after a delay
          setTimeout(() => {
            setIsChangingLanguage(false);
          }, 500);
        }, 500);
      }
    }, 1000);
    
    return () => clearTimeout(timer);
  }, [sourceLanguage]);

  // Update the component mount/unmount effect
  useEffect(() => {
    // Log when the VRCTalk component is mounted
    info('[VRCTALK] Component mounted');
    info(`[VRCTALK] Global SR initialized: ${globalSRInitialized}, Global SR exists: ${!!globalSpeechRecognizer}`);
    info(`[VRCTALK] Recognition active: ${recognitionActive}, SR status: ${sr ? sr.status() : 'no sr'}`);
    
    // If we need to initialize speech recognition on mount
    if (sr && recognitionActive && !sr.status()) {
      info('[VRCTALK] Starting speech recognition on component mount');
      sr.start();
    }
    
    return () => {
      // Log when the VRCTalk component is unmounted (tab changed)
      info('[VRCTALK] Component unmounting');
      info(`[VRCTALK] SR status at unmount: ${sr ? sr.status() : 'no sr'}`);
      
      try {
        // Only handle the speech recognizer if it exists
        if (sr) {
          // Store the current recognition state in a variable to restore it later
          const wasRunning = sr.status();
          info(`[VRCTALK] Recognition state at unmount: ${wasRunning ? 'running' : 'stopped'}`);
          
          // We want to preserve the global speech recognizer instance
          // but pause it temporarily during tab switch to avoid issues
          if (wasRunning) {
            info('[VRCTALK] Pausing global speech recognizer during tab switch');
            
            // We'll use a flag in localStorage to track that we need to restart on return
            localStorage.setItem('vrctalk_recognition_paused', 'true');
            
            // Temporarily stop the recognizer
            sr.stop();
            
            // Schedule a restart after a short delay in case we return quickly
            setTimeout(() => {
              // Only restart if we're still on the settings page (not returned to main yet)
              if (document.location.hash.includes('settings') && sr && !sr.status()) {
                info('[VRCTALK] Restarting recognition after pause');
                sr.start();
              }
            }, 2000);
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        error(`[VRCTALK] Error during component unmount: ${errorMessage}`);
      }
    };
  }, []);

  // Add an effect that runs when the component mounts to check if we need to restore recognition
  useEffect(() => {
    // Check if we need to restore recognition state
    const needsRestore = localStorage.getItem('vrctalk_recognition_paused') === 'true';
    
    if (needsRestore && sr && recognitionActive && !sr.status()) {
      info('[VRCTALK] Restoring speech recognition after tab switch');
      localStorage.removeItem('vrctalk_recognition_paused');
      
      // Short delay to ensure component is fully mounted
      setTimeout(() => {
        if (sr && recognitionActive && !sr.status()) {
          info('[VRCTALK] Starting speech recognition after restoration');
          sr.restart(); // Use restart instead of start for a clean state
        }
      }, 500);
    }
  }, [sr, recognitionActive]);

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
            {isChangingLanguage && (
              <div className="ml-2 status-processing">
                <div className="mr-1 h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"></div>
                Changing Language
              </div>
            )}
          </div>
          <div className={`text-display relative overflow-hidden ${detecting || isChangingLanguage ? 'text-display-active' : ''}`}>
            <div key={sourceText} className={`transition-all duration-300 ${sourceText ? 'animate-slide-up' : ''}`}>
              {sourceText || (
                <span className="text-gray-400 italic">
                  {isChangingLanguage ? 'Changing language...' : 'Waiting for speech...'}
                </span>
              )}
            </div>
            {detecting && (
              <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-green-400 via-blue-500 to-green-400 shimmer"></div>
            )}
            {isChangingLanguage && (
              <div className="absolute bottom-0 left-0 w-full h-1 bg-gradient-to-r from-blue-400 via-purple-500 to-blue-400 shimmer"></div>
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
                <span className="text-gray-400 italic">
                  {isChangingLanguage ? 'Changing language...' : 'Translation will appear here...'}
                </span>
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