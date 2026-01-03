use futures_util::StreamExt;
use hound::WavReader;
use reqwest;
use std::fs;
use std::io::Cursor;
use std::io::Write;
use std::path::PathBuf;
use tauri::{Emitter, Manager};
// Whisper imports
use std::sync::{Arc, Mutex};
use tauri::State;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext};

pub struct WhisperAppState {
    pub state: Arc<Mutex<Option<(WhisperContext, String)>>>,
}

// Model configurations with GGML files to download
static MODEL_CONFIGS: &[(&str, &str, &[&str])] = &[
    ("tiny", "ggerganov/whisper.cpp", &["ggml-tiny.bin"]),
    ("base", "ggerganov/whisper.cpp", &["ggml-base.bin"]),
    ("small", "ggerganov/whisper.cpp", &["ggml-small.bin"]),
    ("medium", "ggerganov/whisper.cpp", &["ggml-medium.bin"]),
    ("large", "ggerganov/whisper.cpp", &["ggml-large-v3.bin"]),
];

// Audio processing validation function
fn validate_audio_data(audio_data: &[u8]) -> Result<(), String> {
    if audio_data.is_empty() {
        return Err("Audio data is empty".to_string());
    }

    // Basic audio format validation
    if audio_data.len() < 44 {
        // Not necessarily an error - could be raw PCM data
        println!(
            "Warning: Audio data smaller than typical WAV header size ({} bytes)",
            audio_data.len()
        );
    }

    // More reasonable audio data size check
    // Increased limit to accommodate longer recordings
    if audio_data.len() > 20_000_000 {
        return Err("Audio data too large (>20MB)".to_string());
    }

    Ok(())
}

// Audio format detection and validation
fn detect_audio_format(audio_data: &[u8]) -> Result<String, String> {
    if audio_data.len() < 4 {
        return Err("Audio data too short for format detection".to_string());
    }

    // Check for WAV header
    if &audio_data[0..4] == b"RIFF" {
        return Ok("WAV".to_string());
    }

    // Check for raw PCM (assume if no header detected)
    Ok("PCM".to_string())
}

// Convert audio data to the format expected by Whisper (16kHz mono f32)
fn process_audio_for_whisper(audio_data: &[u8]) -> Result<Vec<f32>, String> {
    println!("Processing audio data for Whisper inference...");

    // Try to parse as WAV first
    let cursor = Cursor::new(audio_data);
    match WavReader::new(cursor) {
        Ok(mut reader) => {
            let spec = reader.spec();
            println!(
                "WAV format - Sample rate: {}, Channels: {}, Bits per sample: {}",
                spec.sample_rate, spec.channels, spec.bits_per_sample
            );

            // Read samples
            let samples: Result<Vec<i16>, _> = reader.samples::<i16>().collect();
            let samples = samples.map_err(|e| format!("Failed to read WAV samples: {}", e))?;

            // Convert to mono if stereo
            let mono_samples: Vec<i16> = if spec.channels == 2 {
                samples
                    .chunks(2)
                    .map(|chunk| ((chunk[0] as i32 + chunk[1] as i32) / 2) as i16)
                    .collect()
            } else {
                samples
            };

            // Convert to f32 and normalize
            let mut float_samples: Vec<f32> = mono_samples
                .iter()
                .map(|&sample| sample as f32 / 32768.0)
                .collect();

            // Resample to 16kHz if needed
            if spec.sample_rate != 16000 {
                println!("Resampling from {}Hz to 16000Hz", spec.sample_rate);
                // Simple linear interpolation resampling
                let ratio = spec.sample_rate as f32 / 16000.0;
                let new_length = (float_samples.len() as f32 / ratio) as usize;
                let mut resampled = Vec::with_capacity(new_length);

                for i in 0..new_length {
                    let src_index = (i as f32 * ratio) as usize;
                    if src_index < float_samples.len() {
                        resampled.push(float_samples[src_index]);
                    }
                }
                float_samples = resampled;
            }

            println!("Processed audio: {} samples at 16kHz", float_samples.len());
            Ok(float_samples)
        }
        Err(_) => {
            // Assume raw PCM data
            println!("Treating as raw PCM data");
            if audio_data.len() % 2 != 0 {
                return Err("Raw PCM data length must be even (16-bit samples)".to_string());
            }

            let samples: Vec<i16> = audio_data
                .chunks_exact(2)
                .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                .collect();

            let float_samples: Vec<f32> = samples
                .iter()
                .map(|&sample| sample as f32 / 32768.0)
                .collect();

            println!("Processed raw PCM: {} samples", float_samples.len());
            Ok(float_samples)
        }
    }
}

// Run actual Whisper inference using whisper-rs
// Run inference on an existing Whisper context
fn run_inference_on_context(
    ctx: &WhisperContext,
    audio_samples: &[f32],
    language: &str,
) -> Result<String, String> {
    println!("Starting inference on context...");

    // Create params with greedy sampling
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

    // Set language (convert to Whisper 2-letter format)
    let whisper_lang = match language {
        "en-US" | "en" => "en",
        "ja-JP" | "ja" => "ja",
        "ko-KR" | "ko" => "ko",
        "id-ID" | "id" => "id",
        "zh-CN" | "zh" => "zh",
        "es-ES" | "es" => "es",
        "fr-FR" | "fr" => "fr",
        "de-DE" | "de" => "de",
        "it-IT" | "it" => "it",
        "pt-PT" | "pt" => "pt",
        "ru-RU" | "ru" => "ru",
        "nl-NL" | "nl" => "nl",
        "pl-PL" | "pl" => "pl",
        "tr-TR" | "tr" => "tr",
        "vi-VN" | "vi" => "vi",
        "th-TH" | "th" => "th",
        lang if lang.len() >= 2 => &lang[..2],
        _ => "en",
    };

    params.set_language(Some(whisper_lang));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    
    // Additional parameters to reduce hallucinations and improve quality
    params.set_suppress_blank(true); // Suppress blank outputs
    params.set_suppress_non_speech_tokens(true); // Suppress non-speech tokens
    params.set_temperature(0.0); // Use greedy decoding (no randomness)
    params.set_no_context(true); // Don't use context to prevent hallucination continuation
    params.set_single_segment(false); // Allow multiple segments for better accuracy

    // Create state
    let mut state = ctx
        .create_state()
        .map_err(|e| format!("Failed to create Whisper state: {:?}", e))?;

    // Run inference
    state
        .full(params, audio_samples)
        .map_err(|e| format!("Whisper inference failed: {:?}", e))?;

    // Collect transcription
    let num_segments = state
        .full_n_segments()
        .map_err(|e| format!("Failed to get segments: {:?}", e))?;

    let mut transcription = String::new();
    for i in 0..num_segments {
        if let Ok(segment) = state.full_get_segment_text(i) {
            transcription.push_str(&segment);
        }
    }

    // Clean up the transcription
    let cleaned = transcription.trim()
        // Remove Whisper hallucination tokens
        .replace("[BLANK_AUDIO]", "")
        .replace("(BLANK_AUDIO)", "")
        .replace("[MUSIC]", "")
        .replace("[NOISE]", "")
        .replace("(music)", "")
        .replace("(inaudible)", "")
        // Remove common Whisper artifacts
        .replace("...", "")
        .trim()
        .to_string();

    Ok(cleaned)
}

// Simple speech activity detection based on audio energy
fn detect_speech_activity(audio_samples: &[f32]) -> Result<bool, String> {
    if audio_samples.is_empty() {
        return Ok(false);
    }

    // Calculate RMS (Root Mean Square) energy
    let rms = {
        let sum_squares: f32 = audio_samples.iter().map(|&x| x * x).sum();
        (sum_squares / audio_samples.len() as f32).sqrt()
    };

    // Calculate peak amplitude
    let peak = audio_samples
        .iter()
        .map(|&x| x.abs())
        .fold(0.0f32, f32::max);

    println!("Audio analysis - RMS: {:.6}, Peak: {:.6}", rms, peak);

    // Check minimum audio duration (at least 0.5 seconds of actual audio)
    // At 16kHz, 0.5 seconds = 8000 samples
    let min_samples = 8000;
    if audio_samples.len() < min_samples {
        println!("Audio too short ({} samples, need at least {}), skipping", audio_samples.len(), min_samples);
        return Ok(false);
    }

    // Higher thresholds to reduce sensitivity and false positives from background noise
    // These values require clear, intentional speech to trigger transcription
    let rms_threshold = 0.02; // Doubled from 0.01 - requires more energy
    let peak_threshold = 0.1; // Doubled from 0.05 - requires clearer peaks

    let has_energy = rms > rms_threshold;
    let has_peaks = peak > peak_threshold;

    // Check for dynamic range (speech typically has varying amplitude)
    let mut amplitude_changes = 0;
    let window_size = audio_samples.len() / 10; // Divide into 10 segments
    if window_size > 0 {
        for i in 0..9 {
            let start = i * window_size;
            let end = (i + 1) * window_size;
            let segment_rms = {
                let sum_squares: f32 = audio_samples[start..end].iter().map(|&x| x * x).sum();
                (sum_squares / window_size as f32).sqrt()
            };

            let next_start = (i + 1) * window_size;
            let next_end = if i + 2 < 10 {
                (i + 2) * window_size
            } else {
                audio_samples.len()
            };
            let next_segment_rms = {
                let sum_squares: f32 = audio_samples[next_start..next_end]
                    .iter()
                    .map(|&x| x * x)
                    .sum();
                (sum_squares / (next_end - next_start) as f32).sqrt()
            };

            if (segment_rms - next_segment_rms).abs() > 0.015 {
                // Require significant variation - speech has dynamic range, noise is static
                amplitude_changes += 1;
            }
        }
    }

    // Require at least 3 amplitude changes to ensure it's dynamic speech, not static noise
    let has_variation = amplitude_changes >= 3;

    println!(
        "Speech detection - Energy: {}, Peaks: {}, Variation: {} changes",
        has_energy, has_peaks, amplitude_changes
    );

    // Speech is detected if we have sufficient energy, peaks, AND variation
    // All three conditions required to reduce false positives
    let speech_detected = has_energy && has_peaks && has_variation;

    Ok(speech_detected)
}

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    println!("Getting models directory path...");

    let app_data = app_handle.path().app_data_dir().map_err(|e| {
        let error_msg = format!("Failed to get app data directory: {}", e);
        println!("ERROR: {}", error_msg);
        error_msg
    })?;

    println!("App data directory: {:?}", app_data);

    let models_dir = app_data.join("whisper_models");
    println!("Target models directory: {:?}", models_dir);

    // Ensure parent directory exists and handle conflicts
    if let Some(parent) = models_dir.parent() {
        if parent.exists() {
            if parent.is_file() {
                println!("Found conflicting file at parent directory path, removing...");
                fs::remove_file(parent).map_err(|e| {
                    let error_msg = format!("Failed to remove conflicting parent file: {}", e);
                    println!("ERROR: {}", error_msg);
                    error_msg
                })?;
                println!("Creating parent directory: {:?}", parent);
                fs::create_dir_all(parent).map_err(|e| {
                    let error_msg = format!("Failed to create parent directory: {}", e);
                    println!("ERROR: {}", error_msg);
                    error_msg
                })?;
            } else {
                println!("Parent directory already exists: {:?}", parent);
            }
        } else {
            println!("Creating parent directory: {:?}", parent);
            fs::create_dir_all(parent).map_err(|e| {
                let error_msg = format!("Failed to create parent directory: {}", e);
                println!("ERROR: {}", error_msg);
                error_msg
            })?;
        }
    }

    // Check if path exists and handle conflicts
    if models_dir.exists() {
        if models_dir.is_file() {
            println!("Found conflicting file at models directory path, removing...");
            fs::remove_file(&models_dir).map_err(|e| {
                let error_msg = format!("Failed to remove conflicting file: {}", e);
                println!("ERROR: {}", error_msg);
                error_msg
            })?;
        } else if models_dir.is_dir() {
            println!("Models directory already exists");
            return Ok(models_dir);
        }
    }

    // Create the directory
    println!("Creating models directory...");
    fs::create_dir_all(&models_dir).map_err(|e| {
        let error_msg = format!(
            "Failed to create models directory '{}': {}",
            models_dir.display(),
            e
        );
        println!("ERROR: {}", error_msg);
        error_msg
    })?;

    println!("Models directory created successfully: {:?}", models_dir);
    Ok(models_dir)
}

fn get_model_path(app_handle: &tauri::AppHandle, model_id: &str) -> Result<PathBuf, String> {
    let models_dir = get_models_dir(app_handle)?;
    Ok(models_dir.join(model_id))
}

async fn download_file_from_huggingface(
    app_handle: &tauri::AppHandle,
    repo_id: &str,
    filename: &str,
    local_path: &PathBuf,
    model_id: &str,
) -> Result<(), String> {
    let url = format!(
        "https://huggingface.co/{}/resolve/main/{}",
        repo_id, filename
    );
    println!("Downloading {} from {}", filename, url);

    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "HTTP error {}: {}",
            response.status(),
            response.status().canonical_reason().unwrap_or("Unknown")
        ));
    }

    let total_size = response.content_length().unwrap_or(0);
    println!("File size: {} bytes", total_size);

    let mut file =
        fs::File::create(local_path).map_err(|e| format!("Failed to create file: {}", e))?;

    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read chunk: {}", e))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Failed to write chunk: {}", e))?;

        downloaded += chunk.len() as u64;
        if total_size > 0 {
            let progress = (downloaded as f64 / total_size as f64) * 100.0;

            // Emit progress event to frontend
            let progress_payload = serde_json::json!({
                "model": model_id,
                "file": filename,
                "progress": progress,
                "downloaded": downloaded,
                "total": total_size
            });

            let _ = app_handle.emit("download-progress", &progress_payload);

            if downloaded % (1024 * 1024) == 0 || downloaded == total_size {
                // Log every MB or at completion
                println!(
                    "Progress: {:.1}% ({}/{} bytes)",
                    progress, downloaded, total_size
                );
            }
        }
    }

    println!(
        "Successfully downloaded {} ({} bytes)",
        filename, downloaded
    );
    Ok(())
}

#[tauri::command]
pub async fn whisper_download_model(
    app_handle: tauri::AppHandle,
    model: String,
) -> Result<bool, String> {
    println!("=== WHISPER MODEL DOWNLOAD START ===");
    println!("Downloading Whisper model: {}", model);

    // Validate model exists
    let model_info = MODEL_CONFIGS
        .iter()
        .find(|(id, _, _)| *id == model)
        .ok_or_else(|| {
            let error_msg = format!("Unknown model: {}", model);
            println!("ERROR: {}", error_msg);
            error_msg
        })?;

    let (model_id, repo_id, files_to_download) = *model_info;
    println!(
        "Model info: id={}, repo_id={}, files={:?}",
        model_id, repo_id, files_to_download
    );

    // Get model path
    let model_path = match get_model_path(&app_handle, model_id) {
        Ok(path) => {
            println!("Model path: {:?}", path);
            path
        }
        Err(e) => {
            println!("ERROR: Failed to get model path: {}", e);
            return Err(e);
        }
    };

    // Create model directory
    if !model_path.exists() {
        println!("Creating model directory: {:?}", model_path);
        fs::create_dir_all(&model_path).map_err(|e| {
            let error_msg = format!(
                "Failed to create model directory '{}': {}",
                model_path.display(),
                e
            );
            println!("ERROR: {}", error_msg);
            error_msg
        })?;
        println!("Model directory created successfully");
    } else {
        println!("Model directory already exists");
    }

    println!(
        "Downloading {} files from Hugging Face...",
        files_to_download.len()
    );

    // Download each file
    for (i, filename) in files_to_download.iter().enumerate() {
        let local_path = model_path.join(filename);
        println!(
            "Processing file {}/{}: {} -> {:?}",
            i + 1,
            files_to_download.len(),
            filename,
            local_path
        );

        // Skip if file already exists and is not empty
        if local_path.exists() {
            let file_size = fs::metadata(&local_path).map(|m| m.len()).unwrap_or(0);
            if file_size > 0 {
                println!(
                    "File {} already exists ({} bytes), skipping",
                    filename, file_size
                );
                continue;
            } else {
                println!("File {} exists but is empty, re-downloading", filename);
            }
        }

        // Download the file
        match download_file_from_huggingface(&app_handle, repo_id, filename, &local_path, model_id)
            .await
        {
            Ok(()) => {
                println!("Successfully downloaded file: {}", filename);
            }
            Err(e) => {
                println!("ERROR: Failed to download {}: {}", filename, e);
                // Remove partial file if it exists
                if local_path.exists() {
                    let _ = fs::remove_file(&local_path);
                }
                return Err(format!("Failed to download {}: {}", filename, e));
            }
        }
    }

    println!("=== WHISPER MODEL DOWNLOAD COMPLETE ===");
    println!("Model {} downloaded successfully", model_id);
    Ok(true)
}

#[tauri::command]
pub async fn whisper_is_model_downloaded(
    app_handle: tauri::AppHandle,
    model: String,
) -> Result<bool, String> {
    let model_path = get_model_path(&app_handle, &model)?;

    if !model_path.exists() {
        return Ok(false);
    }

    // Get the model config to check required files
    let model_info = MODEL_CONFIGS
        .iter()
        .find(|(id, _, _)| *id == model)
        .ok_or_else(|| format!("Unknown model: {}", model))?;

    let (_, _, required_files) = *model_info;

    // Check if all required files exist and are not empty
    for file in required_files {
        let file_path = model_path.join(file);
        if !file_path.exists() {
            return Ok(false);
        }

        // Check file size - real model files should be larger than 1KB
        let file_size = fs::metadata(&file_path).map(|m| m.len()).unwrap_or(0);

        if file_size == 0 {
            return Ok(false);
        }

        // For GGML model files, expect significant size (at least 10MB for tiny model)
        if file.ends_with(".bin") && file_size < 10_000_000 {
            return Ok(false);
        }
    }

    Ok(true)
}

#[tauri::command]
pub async fn whisper_get_downloaded_models(
    app_handle: tauri::AppHandle,
) -> Result<Vec<String>, String> {
    let models_dir = get_models_dir(&app_handle)?;
    let mut downloaded_models = Vec::new();

    if !models_dir.exists() {
        return Ok(downloaded_models);
    }

    let entries =
        fs::read_dir(&models_dir).map_err(|e| format!("Failed to read models directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();

        if path.is_dir() {
            if let Some(model_name) = path.file_name().and_then(|n| n.to_str()) {
                // Check if this model is fully downloaded
                if whisper_is_model_downloaded(app_handle.clone(), model_name.to_string()).await? {
                    downloaded_models.push(model_name.to_string());
                }
            }
        }
    }

    Ok(downloaded_models)
}

#[tauri::command]
pub async fn whisper_transcribe(
    app_handle: tauri::AppHandle,
    state: State<'_, WhisperAppState>,
    audio_data: Vec<u8>,
    model: String,
    language: String,
) -> Result<String, String> {
    println!("=== WHISPER TRANSCRIPTION START ===");
    println!(
        "Model: {}, Language: {}, Audio Size: {}",
        model,
        language,
        audio_data.len()
    );

    // Process audio data first
    validate_audio_data(&audio_data)?;
    let audio_samples = process_audio_for_whisper(&audio_data)?;

    // Check speech activity (lightweight check before locking)
    match detect_speech_activity(&audio_samples) {
        Ok(has_speech) => {
            if !has_speech {
                println!("No speech detected, skipping inference");
                return Ok("".to_string());
            }
        }
        Err(e) => println!("Warning: Speech detection failed: {}", e),
    }

    println!("Speech detected. Preparing inference...");

    // Get model path (needed if we need to load)
    let model_path = get_model_path(&app_handle, &model)?;
    let model_name = model_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Invalid model path".to_string())?;
    let model_file = model_path.join(format!("ggml-{}.bin", model_name));

    if !model_file.exists() {
        return Err(format!("Model file missing: {:?}", model_file));
    }

    let model_file_str = model_file
        .to_str()
        .ok_or_else(|| "Invalid model path".to_string())?
        .to_string();

    // Run in blocking task with state lock
    let state_arc = state.state.clone();
    let language_clone = language.clone();

    println!("Acquiring state lock and running inference...");

    let model_clone = model.clone();
    let transcription = tokio::task::spawn_blocking(move || {
        // Lock the mutex - this serializes all inference requests
        let mut guard = state_arc
            .lock()
            .map_err(|e| format!("Mutex poisoned: {:?}", e))?;

        // Check if we need to reload the model
        let needs_reload = match guard.as_ref() {
            None => {
                println!("No model loaded yet, loading for first time...");
                true
            }
            Some((_, cached_model)) => {
                if cached_model != &model_clone {
                    println!("Model changed from '{}' to '{}', reloading...", cached_model, model_clone);
                    true
                } else {
                    println!("Using existing cached model '{}'", cached_model);
                    false
                }
            }
        };

        // Load or reload model if needed
        if needs_reload {
            println!("Loading Whisper model from disk...");
            println!("Path: {}", model_file_str);
            let ctx = WhisperContext::new(&model_file_str)
                .map_err(|e| format!("Failed to create WhisperContext: {:?}", e))?;
            *guard = Some((ctx, model_clone.clone()));
            println!("Model '{}' loaded successfully and cached.", model_clone);
        }

        // Run inference on the locked context
        if let Some((ctx, _)) = guard.as_ref() {
            run_inference_on_context(ctx, &audio_samples, &language_clone)
        } else {
            Err("Whisper context is missing".to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {:?}", e))??;

    println!("Transcription result: '{}'", transcription);
    Ok(transcription)
}
