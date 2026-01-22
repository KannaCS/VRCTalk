import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { info, error } from '@tauri-apps/plugin-log';

import { Recognizer } from '../recognizers/recognizer';
import { WebSpeech } from '../recognizers/WebSpeech';
import { Whisper } from '../recognizers/Whisper';
import translateGT from '../translators/google_translate';
import translateGemini from '../translators/gemini_translate';
import translateGroq from '../translators/groq_translate';
import { Config, saveConfig } from '../utils/config';
import { calculateMinWaitTime, langSource, langTo, findLangSourceIndex, findLangToIndex } from '../utils/constants';

type MessageItem = { src: string; tgt: string; time: number };

interface VRCTalkProps {
  config: Config;
  setConfig: React.Dispatch<React.SetStateAction<Config | null>>;
  onNewMessage?: (sourceText: string, translatedText: string) => void;
  history?: MessageItem[];
  onHistoryToggle?: () => void;
  showHistory?: boolean;
}

// Global variables for detection queue and lock
let detectionQueue: string[] = [];
let lock = false;

// Global speech recognition instance to prevent multiple instances
let globalSpeechRecognizer: Recognizer | null = null;
let globalSRInitialized = false;

const VRCTalk: React.FC<VRCTalkProps> = ({ config, setConfig, onNewMessage, onHistoryToggle }) => {
  const [detecting, setDetecting] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [recognitionActive, setRecognitionActive] = useState(true);
  const [vrcMuted, setVRCMuted] = useState(false);
  const [audioActive, setAudioActive] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);

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
  const [whisperStatus, setWhisperStatus] = useState<string>("");
  const firstResultRef = useRef(false);
  const [styleDropdownOpen, setStyleDropdownOpen] = useState(false);
  const styleDropdownRef = useRef<HTMLDivElement>(null);
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const sourceDropdownRef = useRef<HTMLDivElement>(null);
  const targetDropdownRef = useRef<HTMLDivElement>(null);

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
    const shouldBeWhisper = config.recognizer === 'whisper';

    if (currentIsWhisper !== shouldBeWhisper) {
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
            // Translation mode - use selected translator
            if (config.translator === 'gemini' && config.gemini_api_key) {
              translatedResult = await translateGemini(text, sourceLanguage, targetLanguage, config.gemini_api_key, config.translation_style);
              info("[TRANSLATION] Gemini translation succeeded!");
            } else if (config.translator === 'groq') {
              // Groq works with or without user API key (has built-in keys with fallback)
              translatedResult = await translateGroq(text, sourceLanguage, targetLanguage, config.groq_api_key || '', config.translation_style);
              info("[TRANSLATION] Groq translation succeeded!");
            } else {
              translatedResult = await translateGT(text, sourceLanguage, targetLanguage);
              info("[TRANSLATION] Google translation succeeded!");
            }
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
    } else if (recognitionActive && sr) {
      // Check if SR is initialized (has status method)
      const isRunning = sr.status();
      if (isRunning || audioActive) {
        setMicStatus(detecting ? 'listening' : 'active');
        // Also update defaultMicrophone if still showing Initializing
        if (defaultMicrophone === "Initializing...") {
          setDefaultMicrophone("Microphone Active");
        }
      }
    } else if (sr && !recognitionActive) {
      setMicStatus('muted');
    }
  }, [recognitionActive, vrcMuted, config.vrchat_settings.disable_when_muted, sr, detecting, audioActive, defaultMicrophone]);

  // Audio level monitoring for visualizer
  useEffect(() => {
    let mediaStream: MediaStream | null = null;

    const setupAudioMonitoring = async () => {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(mediaStream);

        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        source.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const checkAudioLevel = () => {
          if (!analyserRef.current) return;

          analyserRef.current.getByteFrequencyData(dataArray);
          const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;

          // Threshold for "hearing something" - adjust as needed
          const isActive = average > 15 && recognitionActiveRef.current;
          setAudioActive(isActive);

          animationFrameRef.current = requestAnimationFrame(checkAudioLevel);
        };

        checkAudioLevel();
      } catch (err) {
        error(`[AUDIO] Failed to setup audio monitoring: ${err}`);
      }
    };

    setupAudioMonitoring();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (styleDropdownRef.current && !styleDropdownRef.current.contains(event.target as Node)) {
        setStyleDropdownOpen(false);
      }
      if (sourceDropdownRef.current && !sourceDropdownRef.current.contains(event.target as Node)) {
        setSourceDropdownOpen(false);
      }
      if (targetDropdownRef.current && !targetDropdownRef.current.contains(event.target as Node)) {
        setTargetDropdownOpen(false);
      }
    };

    if (styleDropdownOpen || sourceDropdownOpen || targetDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [styleDropdownOpen, sourceDropdownOpen, targetDropdownOpen]);

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

  // Copy to clipboard helper
  const copyToClipboard = async (text: string, type: 'source' | 'translation') => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      // Visual feedback would be nice here
      info(`[COPY] Copied ${type} text to clipboard`);
    } catch (e) {
      error(`[COPY] Failed to copy: ${e}`);
    }
  };

  // Audio Visualizer component
  const AudioVisualizer = ({ active, large = false }: { active: boolean; large?: boolean }) => (
    <div className={`audio-visualizer ${large ? 'large' : ''}`} style={{ opacity: active ? 1 : 0.3 }}>
      <div className="bar" style={{ animationPlayState: active ? 'running' : 'paused' }}></div>
      <div className="bar" style={{ animationPlayState: active ? 'running' : 'paused' }}></div>
      <div className="bar" style={{ animationPlayState: active ? 'running' : 'paused' }}></div>
      <div className="bar" style={{ animationPlayState: active ? 'running' : 'paused' }}></div>
      <div className="bar" style={{ animationPlayState: active ? 'running' : 'paused' }}></div>
    </div>
  );

  // UI component return - LinguaFlow-inspired layout
  return (
    <div className={`flex flex-col gap-6 theme-${config.theme_color}`}>
      {/* Centered Language Selector Header */}
      <div className="flex items-center justify-center py-2 gap-3">
        <div className="language-selector-pill">
          {/* Source Language Custom Dropdown */}
          <div className="relative" ref={sourceDropdownRef}>
            <button
              onClick={() => { setSourceDropdownOpen(!sourceDropdownOpen); setTargetDropdownOpen(false); }}
              disabled={isChangingLanguage}
              className="flex items-center gap-1 px-3 py-1 text-white text-sm font-medium hover:bg-white/10 rounded-lg transition-all"
            >
              <span>{langSource.find(l => l.code === sourceLanguage)?.name || sourceLanguage}</span>
              <svg className={`w-3 h-3 transition-transform ${sourceDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {sourceDropdownOpen && (
              <div className="absolute top-full left-0 mt-2 min-w-[180px] max-h-64 overflow-y-auto bg-dark-800/95 backdrop-blur-xl rounded-xl border border-white/10 shadow-2xl z-50 animate-slide-up">
                {langSource.map((lang, index) => (
                  <button
                    key={`source-${index}`}
                    onClick={() => {
                      handleSourceLanguageChange({ target: { value: lang.code } } as React.ChangeEvent<HTMLSelectElement>);
                      setSourceDropdownOpen(false);
                    }}
                    className={`w-full px-4 py-2.5 text-left text-sm transition-all first:rounded-t-xl last:rounded-b-xl ${sourceLanguage === lang.code
                        ? 'bg-accent-400/20 text-white font-medium'
                        : 'text-white/80 hover:bg-white/10 hover:text-white'
                      }`}
                  >
                    {lang.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={swapLanguages}
            disabled={isChangingLanguage}
            className="swap-btn"
            title="Swap Languages"
          >
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>

          {/* Target Language Custom Dropdown */}
          <div className="relative" ref={targetDropdownRef}>
            <button
              onClick={() => { setTargetDropdownOpen(!targetDropdownOpen); setSourceDropdownOpen(false); }}
              disabled={isChangingLanguage}
              className="flex items-center gap-1 px-3 py-1 text-white text-sm font-medium hover:bg-white/10 rounded-lg transition-all"
            >
              <span>{langTo.find(l => l.code === targetLanguage)?.name || targetLanguage}</span>
              <svg className={`w-3 h-3 transition-transform ${targetDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {targetDropdownOpen && (
              <div className="absolute top-full right-0 mt-2 min-w-[180px] max-h-64 overflow-y-auto bg-dark-800/95 backdrop-blur-xl rounded-xl border border-white/10 shadow-2xl z-50 animate-slide-up">
                {langTo.map((lang, index) => (
                  <button
                    key={`target-${index}`}
                    onClick={() => {
                      handleTargetLanguageChange({ target: { value: lang.code } } as React.ChangeEvent<HTMLSelectElement>);
                      setTargetDropdownOpen(false);
                    }}
                    className={`w-full px-4 py-2.5 text-left text-sm transition-all first:rounded-t-xl last:rounded-b-xl ${targetLanguage === lang.code
                        ? 'bg-accent-400/20 text-white font-medium'
                        : 'text-white/80 hover:bg-white/10 hover:text-white'
                      }`}
                  >
                    {lang.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* History Button */}
        <button
          onClick={() => onHistoryToggle?.()}
          className="flex items-center gap-2 px-4 py-2 rounded-full bg-dark-800/50 border border-accent-400/20 text-white/80 hover:text-white hover:bg-dark-700/50 transition-all text-sm"
          title="View History"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>History</span>
        </button>
      </div>

      {/* Live Session Badge */}
      {/* Manual Input Field (Replaces Live Session Badge) */}
      <div className="flex justify-center w-full max-w-2xl mx-auto px-4">
        <div className="relative w-full">
          <input
            id="manual-input"
            type="text"
            className="w-full bg-dark-800/50 rounded-full px-6 py-3 text-white focus:outline-none focus:ring-2 focus:ring-accent-400 placeholder-white/30 border border-accent-400/20 text-center transition-all shadow-lg"
            placeholder="Type here to translate manually..."
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
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full text-accent-400 hover:bg-accent-400/10 transition-colors"
            disabled={typedText.trim().length === 0 || isChangingLanguage}
            title="Send"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Two-Panel Transcript Layout */}
      <div className={`grid gap-4 ${config.mode === 0 ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 max-w-2xl mx-auto w-full'}`}>
        {/* Source Panel */}
        <div className={`transcript-card animate-slide-up ${detecting || isChangingLanguage ? 'card-active' : ''}`}>
          <div className="transcript-card-header">
            <span className="transcript-card-label">
              {langSource[findLangSourceIndex(sourceLanguage)]?.name?.toUpperCase() || sourceLanguage.toUpperCase()} (SOURCE)
            </span>
            <button
              onClick={() => copyToClipboard(sourceText, 'source')}
              className="copy-btn"
              title="Copy to clipboard"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>

          <div className="transcript-card-content">
            {sourceText || (
              <span className="text-white/40 italic text-xl">
                {isChangingLanguage ? 'Changing language…' : 'Waiting for speech…'}
              </span>
            )}
          </div>

          <div className="transcript-card-status">
            {whisperStatus && (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                </svg>
                <span>{whisperStatus}</span>
              </>
            )}
            {!whisperStatus && detecting && (
              <>
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                </svg>
                <span>Listening...</span>
              </>
            )}
          </div>

          {/* Audio Visualizer in Source Panel */}
          <div className="mt-4">
            <AudioVisualizer active={audioActive || detecting} />
          </div>
        </div>

        {/* Translation Panel - only in translation mode */}
        {config.mode === 0 && (
          <div className={`transcript-card animate-slide-up animate-delay-100 ${translating ? 'card-active' : ''}`}>
            <div className="transcript-card-header">
              <span className="transcript-card-label">
                {langTo[findLangToIndex(targetLanguage)]?.name?.toUpperCase() || targetLanguage.toUpperCase()} (TARGET)
              </span>
              <div className="icon-btn-group">
                {/* Speaker icon (optional for TTS) */}
                <button className="icon-btn" title="Text to speech (coming soon)">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                  </svg>
                </button>
                <button
                  onClick={() => copyToClipboard(translatedText, 'translation')}
                  className="copy-btn"
                  title="Copy to clipboard"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="transcript-card-content">
              {translatedText || (
                <span className="text-white/40 italic text-xl">
                  {isChangingLanguage ? 'Changing language…' : 'Translation updates dynamically'}
                </span>
              )}
            </div>

            <div className="transcript-card-status">
              {translating && (
                <>
                  <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse"></div>
                  <span>Translating...</span>
                </>
              )}
              {!translating && translatedText && (
                <span className="text-white/50">Translation updates dynamically</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Control Bar */}
      <div className="control-bar">


        <div className="control-bar-buttons">
          {/* Refresh/Reset Button */}
          <button
            onClick={() => {
              setSourceText("");
              setTranslatedText("");
              detectionQueue = [];
            }}
            className="control-btn"
            title="Clear transcripts"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>

          {/* Main Stop/Start Button */}
          <button
            onClick={toggleRecognition}
            disabled={isChangingLanguage}
            className={`control-btn-primary ${!recognitionActive ? 'inactive' : ''}`}
          >
            {recognitionActive ? (
              <>
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
                <span>Stop Transcribe</span>
              </>
            ) : (
              <>
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
                <span>Start Transcribe</span>
              </>
            )}
          </button>
        </div>


      </div>

      {/* Manual Input Section (hidden by default, scrollable) */}


      {/* Status Bar */}
      <div className="flex items-center justify-center gap-4 text-xs text-white/50">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${micStatus === 'muted' ? 'bg-yellow-500' :
            (micStatus === 'disconnected' || micStatus === 'error' || micStatus === 'initializing') ? 'bg-red-500' :
              'bg-green-500'
            }`}></div>
          <span>{defaultMicrophone}</span>
        </div>
        <span>•</span>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${vrcMuted ? 'bg-yellow-500' : 'bg-green-500'}`}></div>
          <span>VRChat {vrcMuted ? 'Muted' : 'Connected'}</span>
        </div>
        {(config.translator === 'gemini' || config.translator === 'groq') && (
          <>
            <span>•</span>
            <div className="relative" ref={styleDropdownRef}>
              <button
                onClick={() => setStyleDropdownOpen(!styleDropdownOpen)}
                className="flex items-center gap-1 hover:text-white/80 transition-colors"
              >
                <span className="capitalize">{config.translation_style}</span>
                <svg className={`w-3 h-3 transition-transform ${styleDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {styleDropdownOpen && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-dark-800/95 backdrop-blur-xl rounded-xl border border-accent-400/30 shadow-2xl overflow-hidden z-50 animate-slide-up min-w-[120px]">
                  {[
                    { value: 'casual', emoji: '💬', label: 'Casual' },
                    { value: 'formal', emoji: '🎩', label: 'Formal' },
                    { value: 'polite', emoji: '🙏', label: 'Polite' },
                    { value: 'friendly', emoji: '😊', label: 'Friendly' }
                  ].map((style) => (
                    <button
                      key={style.value}
                      onClick={() => {
                        const newConfig = { ...config, translation_style: style.value };
                        setConfig(newConfig);
                        saveConfig(newConfig).catch(err => error(`Error saving translation style: ${err}`));
                        setStyleDropdownOpen(false);
                      }}
                      className={`w-full px-3 py-2 text-left text-xs flex items-center gap-2 transition-all ${config.translation_style === style.value
                        ? 'bg-accent-400/20 text-white'
                        : 'text-white/70 hover:bg-accent-400/10 hover:text-white'
                        }`}
                    >
                      <span>{style.emoji}</span>
                      <span>{style.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default VRCTalk;