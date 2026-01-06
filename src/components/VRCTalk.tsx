import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { info, error } from '@tauri-apps/plugin-log';

import { Recognizer } from '../recognizers/recognizer';
import { WebSpeech } from '../recognizers/WebSpeech';
import { Whisper } from '../recognizers/Whisper';
import { SystemAudioRecognizer } from '../recognizers/SystemAudioRecognizer';
import translateGT from '../translators/google_translate';
import { Config, saveConfig } from '../utils/config';
import { calculateMinWaitTime, langSource, langTo, findLangSourceIndex, findLangToIndex } from '../utils/constants';

interface VRCTalkProps {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  onNewMessage?: (sourceText: string, translatedText: string) => void;
}

// Global variables for detection queue and lock
let detectionQueue: string[] = [];
let lock = false;

// Global speech recognition instance to prevent multiple instances
let globalSpeechRecognizer: Recognizer | null = null;
let globalSRInitialized = false;

const VRCTalk: React.FC<VRCTalkProps> = ({ config, setConfig, onNewMessage }) => {
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
  const [typedText, setTypedText] = useState("");
  const [micStatus, setMicStatus] = useState<'initializing' | 'active' | 'listening' | 'muted' | 'disconnected' | 'error'>(
    'initializing'
  );
  const [whisperStatus, setWhisperStatus] = useState<string>(""); // Status like "Listening...", "Processing..."
  const firstResultRef = useRef(false);


  // Use global speech recognizer to prevent multiple instances
  const [sr, setSr] = useState<Recognizer | null>(globalSpeechRecognizer);

  // Ref to keep track of recognitionActive state inside event listeners
  const recognitionActiveRef = useRef(recognitionActive);

  // Keep the ref updated whenever recognitionActive changes
  useEffect(() => {
    recognitionActiveRef.current = recognitionActive;
  }, [recognitionActive]);

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

    // Save config asynchronously with error handling
    saveConfig(newConfig).catch(e => {
      error(`[LANGUAGE] Error saving config after language change: ${e}`);
    });

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
        const timeout1 = setTimeout(() => {
          if (sr) {
            sr.set_lang(sourceLanguage);

            // Add small delay before allowing new detections to ensure complete transition
            const timeout2 = setTimeout(() => {
              // Ensure recognition is actually running after language change
              if (sr && recognitionActive && !sr.status()) {
                info("[LANGUAGE] Recognition not running after language change, forcing restart");
                try {
                  sr.start();
                } catch (e) {
                  error(`[LANGUAGE] Error starting recognition after language change: ${e}`);
                }
              }

              // Force trigger a state update to refresh detection state
              setTriggerUpdate(prev => !prev);
              setIsChangingLanguage(false);
            }, 1000);

            // Store timeout for cleanup
            return () => clearTimeout(timeout2);
          }
        }, 200);

        // Store timeout for cleanup
        return () => clearTimeout(timeout1);
      }
      // If only target language changed (not source), we don't need to restart recognition
      else if (prevTargetLang !== targetLanguage) {
        info(`[LANGUAGE] Only target language changed to ${targetLanguage}, no need to restart recognition`);
        setIsChangingLanguage(false);
      }
    }
  }, [sourceLanguage, targetLanguage]);

  // Handle recognizer type changes
  useEffect(() => {
    if (!globalSpeechRecognizer) return;

    // Check if we need to switch recognizer types
    const currentIsWhisper = globalSpeechRecognizer instanceof Whisper;
    const currentIsSystemAudio = globalSpeechRecognizer instanceof SystemAudioRecognizer;
    const shouldBeWhisper = config.recognizer === 'whisper';
    const shouldBeSystemAudio = config.recognizer === 'system_audio';

    if (currentIsWhisper !== shouldBeWhisper || currentIsSystemAudio !== shouldBeSystemAudio) {
      info(`[SR] Recognizer type change detected: switching to ${config.recognizer}`);

      // Stop current recognizer
      if (globalSpeechRecognizer.status()) {
        globalSpeechRecognizer.stop();
      }

      // Create new recognizer
      let newRecognizer: Recognizer;
      if (shouldBeWhisper) {
        newRecognizer = new Whisper(config.source_language, config.whisper_model, config.selected_microphone);
        info(`[SR] Switched to Whisper recognizer with model: ${config.whisper_model}`);
      } else if (shouldBeSystemAudio) {
        newRecognizer = new SystemAudioRecognizer(config.source_language);
        info(`[SR] Switched to System Audio recognizer`);
      } else {
        newRecognizer = new WebSpeech(config.source_language, config.selected_microphone);
        info(`[SR] Switched to WebSpeech recognizer`);
      }

      // Set up result handler for new recognizer
      newRecognizer.onResult((result: string, isFinal: boolean) => {
        info(`[SR] Received speech: Final=${isFinal}, Text=${result.substring(0, 30)}${result.length > 30 ? '...' : ''}`);

        // Check if this is a status message (Whisper-specific)
        const isStatusMessage = result === "Listening..." || result === "Processing..." || result.startsWith("Error:");
        
        if (isStatusMessage) {
          // Handle status messages separately
          setWhisperStatus(result);
          // Don't update sourceText with status messages
          return;
        }
        
        // Clear status when we get actual transcription
        if (result && result.trim().length > 0) {
          setWhisperStatus("");
        }

        // If we receive speech but microphone still shows initializing, assume it's working
        if (defaultMicrophone === "Initializing...") {
          info("[MEDIA] Received speech while microphone showed initializing. Setting status to Microphone Active.");
          setDefaultMicrophone("Microphone Active");
        }
        firstResultRef.current = firstResultRef.current || isFinal || !!result;
        setMicStatus(isFinal ? 'active' : 'listening');

        // Send typing status if configured
        if (config.vrchat_settings.send_typing_status_while_talking || config.mode === 1) {
          invoke("send_typing", {
            address: config.vrchat_settings.osc_address,
            port: `${config.vrchat_settings.osc_port}`
          }).catch(e => {
            error(`[SR] Error sending typing status while talking: ${e}`);
          });
        }

        // Only update sourceText if we have actual content (not empty)
        // This keeps previous transcription visible until new one arrives
        if (result && result.trim().length > 0) {
          setSourceText(result);
        }
        setDetecting(!isFinal);

        // When we get a final transcript, queue it for processing
        if (isFinal && result.trim().length > 0) {
          detectionQueue.push(result);
          // Force the processing loop to run ASAP
          setTriggerUpdate(prev => !prev);
        }
      });

      // Update global references
      globalSpeechRecognizer = newRecognizer;
      setSr(newRecognizer);

      // Start new recognizer if recognition should be active
      if (recognitionActive) {
        setTimeout(() => {
          if (newRecognizer && recognitionActive) {
            newRecognizer.start();
          }
        }, 500);
      }
    }
    // Handle Whisper model changes
    else if (currentIsWhisper && shouldBeWhisper) {
      const whisperRecognizer = globalSpeechRecognizer as Whisper;
      if (whisperRecognizer.model !== config.whisper_model) {
        info(`[SR] Whisper model change detected: switching to ${config.whisper_model}`);
        whisperRecognizer.setModel(config.whisper_model);
      }
    }
  }, [config.recognizer, config.whisper_model]);

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
        try {
          sr.stop();
        } catch (e) {
          error(`[SR] Error stopping recognition due to mute: ${e}`);
        }
      }
      // Otherwise, ensure recognition is running if it's not already
      else if (!sr.status()) {
        info("[SR] Starting/resuming recognition");
        try {
          sr.start();
        } catch (e) {
          error(`[SR] Error starting/resuming recognition: ${e}`);
        }
      }
    } else {
      info("[SR] Stopping recognition by user request");
      try {
        sr.stop();
      } catch (e) {
        error(`[SR] Error stopping recognition by user request: ${e}`);
      }
    }
  }, [recognitionActive, vrcMuted, config.vrchat_settings.disable_when_muted, sr]);

  // Translation processing loop
  useEffect(() => {
    const processTranslation = async () => {
      // If we are offline, wait until connection is restored to avoid useless fetches
      if (!navigator.onLine) {
        info("[TRANSLATION] Skipping translation because network is offline");
        // Don't lock the queue when offline - just skip processing
        return;
      }
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
          let translatedResult = "";
          if (config.mode === 0) {
            // Translation mode
            translatedResult = await translateGT(text, sourceLanguage, targetLanguage);
            info("[TRANSLATION] Translation succeeded!");
          }

          // Apply gender changes if needed (only in translation mode)
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

          if (config.mode === 0) {
            setTranslatedText(finalTranslation);
          } else {
            setTranslatedText("");
          }
          setTranslating(false);

          // Send to VRChat
          info("[TRANSLATION] Sending message to VRChat chatbox");
          const originalText = sourceLanguage === "ja" && config.language_settings.omit_questionmark
            ? text.replace(/？/g, "")
            : text;

          let messageFormat = originalText; // default for transcription

          if (config.mode === 0) {
            // Build translation message
            const divider = ' | ';
            const srcTag = `[${getLangTag(sourceLanguage)}]`;
            const tgtTag = `[${getLangTag(targetLanguage)}]`;

            messageFormat = `${srcTag} ${originalText}${divider}${finalTranslation} ${tgtTag}`;

            if (config.vrchat_settings.only_translation) {
              messageFormat = `${finalTranslation} ${tgtTag}`;
            } else if (config.vrchat_settings.translation_first) {
              messageFormat = `${tgtTag} ${finalTranslation}${divider}${originalText} ${srcTag}`;
            }
          }

          try {
            await invoke("send_message", {
              address: config.vrchat_settings.osc_address,
              port: `${config.vrchat_settings.osc_port}`,
              msg: messageFormat
            });

            // Push to history callback
            if (onNewMessage) {
              onNewMessage(originalText, finalTranslation);
            }


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

          // Always reset translating state on error
          setTranslating(false);

          // If we're out of attempts, still need to unlock
          if (attempts <= 0) {
            lock = false;
            return;
          }
        }

        if (attempts <= 0) break;
      }

      lock = false;
    };

    // Create an abort controller for cleanup
    const abortController = new AbortController();

    processTranslation();

    // Trigger periodic updates to check the queue
    setTimeout(() => {
      if (!abortController.signal.aborted) {
        setTriggerUpdate(prev => !prev);
      }
    }, 100);

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

      // Let the useEffect handle recognition state management
      // Removed direct sr.start() call to avoid race conditions
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
      // This is critical - emit a status event so UI can show error
      // We can fallback gracefully without VRChat integration
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

    // One-time permission unlock to reveal device labels and devicechange hook
    let deviceChangeHandler: any;
    let fallbackTimeout: any;
    const initMedia = async () => {
      try {
        // Ask for audio permission once; then stop tracks immediately
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      } catch (e) {
        // Non-blocking; we'll keep generic labels
      }

      const refreshDevices = async () => {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioInputs = devices.filter(d => d.kind === 'audioinput');
          if (audioInputs.length > 0) {
            let micToUse = audioInputs[0];
            if (config.selected_microphone) {
              const specific = audioInputs.find(d => d.deviceId === config.selected_microphone);
              if (specific) micToUse = specific;
            }
            const label = micToUse.label?.trim();
            if (label) {
              const match = label.match(/^(.*?)(\s+\([^)]+\))?$/);
              const micName = match ? match[1] : label;
              setDefaultMicrophone(micName);
            }
          }
        } catch (_) {
          // ignore
        }
      };

      await refreshDevices();

      deviceChangeHandler = async () => {
        await refreshDevices();
      };
      navigator.mediaDevices.addEventListener?.('devicechange', deviceChangeHandler);

      // Fallback timeout: if SR is running or we got any result, clear initializing label
      fallbackTimeout = setTimeout(() => {
        if ((globalSpeechRecognizer?.status() || firstResultRef.current) && defaultMicrophone === 'Initializing...') {
          setDefaultMicrophone('Microphone Active');
        }
      }, 4000);
    };
    initMedia();

    // Initialize speech recognition based on config
    let recognizer: Recognizer;
    if (config.recognizer === 'whisper') {
      recognizer = new Whisper(config.source_language, config.whisper_model, config.selected_microphone);
      info(`[SR] Initializing Whisper recognizer with model: ${config.whisper_model}`);
    } else if (config.recognizer === 'system_audio') {
      recognizer = new SystemAudioRecognizer(config.source_language);
      info(`[SR] Initializing System Audio recognizer`);
    } else {
      recognizer = new WebSpeech(config.source_language, config.selected_microphone);
      info(`[SR] Initializing WebSpeech recognizer`);
    }
    globalSpeechRecognizer = recognizer;
    setSr(recognizer);

    // Set up the result handler
    recognizer.onResult((result: string, isFinal: boolean) => {
      info(`[SR] Received speech: Final=${isFinal}, Text=${result.substring(0, 30)}${result.length > 30 ? '...' : ''}`);

      // Check if this is a status message (Whisper-specific)
      const isStatusMessage = result === "Listening..." || result === "Processing..." || result.startsWith("Error:");
      
      if (isStatusMessage) {
        // Handle status messages separately
        setWhisperStatus(result);
        // Don't update sourceText with status messages
        return;
      }
      
      // Clear status when we get actual transcription
      if (result && result.trim().length > 0) {
        setWhisperStatus("");
      }

      // If we receive speech but microphone still shows initializing, assume it's working
      if (defaultMicrophone === "Initializing...") {
        info("[MEDIA] Received speech while microphone showed initializing. Setting status to Microphone Active.");
        setDefaultMicrophone("Microphone Active");
      }
      firstResultRef.current = firstResultRef.current || isFinal || !!result;
      setMicStatus(isFinal ? 'active' : 'listening');

      // Send typing status if configured
      if (config.vrchat_settings.send_typing_status_while_talking || config.mode === 1) {
        invoke("send_typing", {
          address: config.vrchat_settings.osc_address,
          port: `${config.vrchat_settings.osc_port}`
        }).catch(e => {
          error(`[SR] Error sending typing status while talking: ${e}`);
        });
      }

      // Only update sourceText if we have actual content (not empty)
      // This keeps previous transcription visible until new one arrives
      if (result && result.trim().length > 0) {
        setSourceText(result);
      }
      setDetecting(!isFinal);

      // When we get a final transcript, queue it for processing
      if (isFinal && result.trim().length > 0) {
        detectionQueue.push(result);
        // Force the processing loop to run ASAP
        setTriggerUpdate(prev => !prev);
      }
    });

    // Start recognition
    recognizer.start();
    info("[SR] Speech recognition started");

    return () => {
      clearInterval(microphoneCheckInterval);

      // Properly cleanup event listeners
      unlistenVrcMute.then(unlisten => unlisten()).catch(e => {
        error(`[CLEANUP] Error cleaning up VRC mute listener: ${e}`);
      });
      unlistenVrcStatus.then(unlisten => unlisten()).catch(e => {
        error(`[CLEANUP] Error cleaning up VRC status listener: ${e}`);
      });
      unlistenVrcError.then(unlisten => unlisten()).catch(e => {
        error(`[CLEANUP] Error cleaning up VRC error listener: ${e}`);
      });

      // Cleanup media listeners and timers
      if (deviceChangeHandler) {
        try { navigator.mediaDevices.removeEventListener?.('devicechange', deviceChangeHandler); } catch { }
      }
      if (fallbackTimeout) clearTimeout(fallbackTimeout);

      // Don't destroy the global speech recognizer, just stop it temporarily
      if (sr && sr === globalSpeechRecognizer) {
        info("[SR] Pausing speech recognition on component unmount (keeping global instance)");
        // Don't call sr.stop() here to avoid conflicts when remounting
      }
    };
  }, []); // Run on every component mount/unmount

  // Derive mic status from recognition/mute states
  useEffect(() => {
    if (vrcMuted && recognitionActive && config.vrchat_settings.disable_when_muted) {
      setMicStatus('muted');
    } else if (recognitionActive && sr?.status()) {
      setMicStatus(detecting ? 'listening' : 'active');
    }
  }, [recognitionActive, vrcMuted, config.vrchat_settings.disable_when_muted, sr, detecting]);

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

  // -------------------------------------------------------------
  // Network connectivity handling
  // -------------------------------------------------------------
  useEffect(() => {
    // Handler for regaining internet connection
    const handleOnline = () => {
      info('[NETWORK] Connection restored (online event)');
      if (globalSpeechRecognizer && recognitionActiveRef.current) {
        // Restart the recognizer only if it is not currently running
        if (!globalSpeechRecognizer.status()) {
          info('[NETWORK] Restarting speech recognition after reconnection');
          try {
            // Use start() instead of restart() to ensure recognition actually resumes
            globalSpeechRecognizer.start();
          } catch (e) {
            error(`[NETWORK] Error starting recognizer after reconnect: ${e}`);
          }
        }
      }
    };

    // Handler for losing internet connection
    const handleOffline = () => {
      info('[NETWORK] Connection lost (offline event)');
      if (globalSpeechRecognizer && globalSpeechRecognizer.status()) {
        try {
          info('[NETWORK] Stopping speech recognition due to connection loss');
          globalSpeechRecognizer.stop();
          // Clear any queued transcripts to prevent a backlog once we come back online
          detectionQueue = [];
          setSourceText('');
          setTranslatedText('');
        } catch (e) {
          error(`[NETWORK] Error stopping recognizer on connection loss: ${e}`);
        }
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Cleanup
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Reflect network status into mic status
  useEffect(() => {
    const apply = () => {
      if (!navigator.onLine) {
        setMicStatus('disconnected');
        return;
      }
      if (vrcMuted && recognitionActive && config.vrchat_settings.disable_when_muted) {
        setMicStatus('muted');
      } else if (recognitionActive && sr?.status()) {
        setMicStatus(detecting ? 'listening' : 'active');
      } else if (!recognitionActive) {
        setMicStatus('active');
      }
    };
    apply();
  }, [recognitionActive, detecting, vrcMuted, config.vrchat_settings.disable_when_muted, sr]);

  // Helper to map language code to display tag
  const getLangTag = (langCode: string): string => {
    const base = langCode.split('-')[0].toLowerCase();
    if (base === 'ja') return 'JP'; // Override Japanese tag from JA to JP
    return base.toUpperCase();
  };

  // Handle manual text submission
  const handleManualSubmit = async () => {
    const text = typedText.trim();
    if (text.length === 0) return;

    // Clear input immediately for better UX
    setTypedText("");

    // Push to translation queue (consistent with speech flow)
    detectionQueue.push(text);
    setTriggerUpdate(prev => !prev);
  };

  // UI component return (Split Compact: sticky header, primary panel 2/3, controls 1/3)
  return (
    <div className="flex flex-col gap-3">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 backdrop-blur supports-[backdrop-filter]:bg-white/5 bg-white/0 rounded-xl border border-white/10 px-3 py-2">
        <div className="flex items-center gap-3 justify-between">
          {/* Language pill */}
          <div className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-2 bg-dark-800/50 text-white rounded-lg px-2 py-1 border border-accent-400/20">
              <span className="font-semibold text-accent-300">
                {langSource[findLangSourceIndex(sourceLanguage)]?.name || sourceLanguage}
              </span>
              <span className="text-accent-200/60">→</span>
              <span className="font-semibold text-accent-200">
                {langTo[findLangToIndex(targetLanguage)]?.name || targetLanguage}
              </span>
            </span>
          </div>

          {/* Status chips */}
          <div className="flex items-center gap-2">
            <div className="flex items-center space-x-2 bg-dark-800/50 rounded-xl px-2 py-1 border border-accent-400/10">
              <div className="relative">
                <div className={`status-dot ${micStatus === 'muted' ? 'status-warning' :
                    (micStatus === 'disconnected' || micStatus === 'error' || micStatus === 'initializing') ? 'status-inactive' :
                      'status-active'
                  }`}></div>
                {recognitionActive && detecting && <div className="mic-pulse" />}
              </div>
              <span className="text-[11px] text-dark-200 truncate max-w-[160px]" title={defaultMicrophone}>
                {(() => {
                  switch (micStatus) {
                    case 'initializing': return 'Initializing…';
                    case 'listening': return 'Listening';
                    case 'muted': return 'Muted';
                    case 'disconnected': return 'Offline';
                    case 'error': return 'Mic Error';
                    case 'active':
                    default:
                      return defaultMicrophone || 'Microphone Active';
                  }
                })()}
              </span>
            </div>
            <div className="flex items-center space-x-2 bg-dark-800/50 rounded-xl px-2 py-1 border border-accent-400/10">
              <div className={`status-dot ${vrcMuted ? 'status-warning' : 'status-active'}`}></div>
              <span className="text-[11px] text-dark-200">{vrcMuted ? 'Muted' : 'Connected'}</span>
            </div>
          </div>

          {/* Recognition toggle */}
          <button
            onClick={toggleRecognition}
            className={`btn-modern flex items-center space-x-1 text-xs ${recognitionActive ? 'btn-danger' : 'btn-success'}`}
            disabled={isChangingLanguage}
          >
            {recognitionActive ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
                <span>Pause</span>
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>Start</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Main Grid */}
      <div className="grid gap-3 lg:grid-cols-3">
        {/* Left 2/3: Primary translation panel with history */}
        <div className="lg:col-span-2 flex flex-col gap-3">
          <div className="modern-card animate-slide-up lg:h-full flex flex-col">
            <div className={`grid grid-cols-1 ${config.mode === 0 ? 'md:grid-cols-2' : ''} gap-3 flex-1 overflow-hidden`}>
              {/* Detected Speech */}
              <div className="flex flex-col">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-medium text-white">Detected</h4>
                  <div className="flex items-center space-x-1">
                    {/* Whisper-specific status indicator */}
                    {whisperStatus && (
                      <div className="flex items-center space-x-1 text-[10px] text-accent-300">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-400 animate-pulse" />
                        <span>{whisperStatus}</span>
                      </div>
                    )}
                    {/* WebSpeech status - only show if no Whisper status */}
                    {!whisperStatus && detecting && (
                      <div className="flex items-center space-x-1 text-[10px] text-accent-300">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-400 animate-pulse" />
                        <span>Listening</span>
                      </div>
                    )}
                    {isChangingLanguage && (
                      <div className="flex items-center space-x-1 text-[10px] text-accent-200">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-300 animate-pulse" />
                        <span>Updating</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className={`text-display-modern flex-1 ${detecting || isChangingLanguage ? 'text-display-active' : ''}`}>
                  <div className="text-white text-sm leading-relaxed break-words overflow-auto max-h-full pr-1">
                    {sourceText || (
                      <span className="text-white/50 italic">
                        {isChangingLanguage ? 'Changing language…' : 'Waiting…'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Translation - only in translation mode */}
              {config.mode === 0 && (
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-sm font-medium text-white">Translation</h4>
                    {translating && (
                      <div className="flex items-center space-x-1 text-[10px] text-accent-300">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-400 animate-pulse" />
                        <span>Working</span>
                      </div>
                    )}
                  </div>
                  <div className={`text-display-modern flex-1 ${translating ? 'text-display-active' : ''}`}>
                    <div className="text-white text-sm leading-relaxed break-words overflow-auto max-h-full pr-1">
                      {translatedText || (
                        <span className="text-white/50 italic">
                          {isChangingLanguage ? 'Changing language…' : 'Translation will appear…'}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>


        </div>

        {/* Right 1/3: Controls drawer (languages + manual input) */}
        <div className="flex flex-col gap-3">
          {/* Languages */}
          <div className="modern-card animate-slide-up">
            <h3 className="text-sm font-semibold text-white mb-3">Languages</h3>
            <div className="grid grid-cols-2 gap-2 items-end">
              <div>
                <label className="block text-[10px] font-medium text-dark-300 mb-1">Source</label>
                <select
                  value={sourceLanguage}
                  onChange={handleSourceLanguageChange}
                  className="select-modern text-xs"
                  disabled={isChangingLanguage}
                >
                  {langSource.map((lang, index) => (
                    <option key={`source-${index}`} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-medium text-dark-300 mb-1">Target</label>
                <select
                  value={targetLanguage}
                  onChange={handleTargetLanguageChange}
                  className="select-modern text-xs"
                  disabled={isChangingLanguage}
                >
                  {langTo.map((lang, index) => (
                    <option key={`target-${index}`} value={lang.code}>{lang.name}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-2 flex justify-center">
                <button
                  onClick={swapLanguages}
                  className="swap-button h-10 w-10 lg:h-12 lg:w-12"
                  disabled={isChangingLanguage}
                  title="Swap Languages"
                >
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Manual Input */}
          <div className="modern-card animate-slide-up animate-delay-100 flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-white">Manual Input</h3>
            <div className="flex items-center space-x-2">
              <input
                type="text"
                className="flex-1 text-xs bg-dark-800/50 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:ring-2 focus:ring-accent-400 placeholder-dark-300 border border-accent-400/20"
                placeholder="Type and press Enter…"
                value={typedText}
                onChange={e => setTypedText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleManualSubmit();
                  }
                }}
                disabled={isChangingLanguage}
              />
              <button
                onClick={handleManualSubmit}
                className="btn-modern btn-primary text-xs px-3 py-1.5"
                disabled={typedText.trim().length === 0 || isChangingLanguage}
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VRCTalk;