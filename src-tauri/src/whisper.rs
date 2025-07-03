use std::fs;
use std::path::PathBuf;
use tauri::{Manager, Emitter};
use reqwest;
use futures_util::StreamExt;
use std::io::Write;

// Model configurations with files to download
static MODEL_CONFIGS: &[(&str, &str, &[&str])] = &[
    ("tiny", "openai/whisper-tiny", &["config.json", "model.safetensors", "tokenizer.json"]),
    ("base", "openai/whisper-base", &["config.json", "model.safetensors", "tokenizer.json"]),
    ("small", "openai/whisper-small", &["config.json", "model.safetensors", "tokenizer.json"]),
    ("medium", "openai/whisper-medium", &["config.json", "model.safetensors", "tokenizer.json"]),
    ("large", "openai/whisper-large-v3", &["config.json", "model.safetensors", "tokenizer.json"]),
];

fn get_models_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    println!("Getting models directory path...");
    
    let app_data = app_handle.path().app_data_dir()
        .map_err(|e| {
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
                fs::remove_file(parent)
                    .map_err(|e| {
                        let error_msg = format!("Failed to remove conflicting parent file: {}", e);
                        println!("ERROR: {}", error_msg);
                        error_msg
                    })?;
                println!("Creating parent directory: {:?}", parent);
                fs::create_dir_all(parent)
                    .map_err(|e| {
                        let error_msg = format!("Failed to create parent directory: {}", e);
                        println!("ERROR: {}", error_msg);
                        error_msg
                    })?;
            } else {
                println!("Parent directory already exists: {:?}", parent);
            }
        } else {
            println!("Creating parent directory: {:?}", parent);
            fs::create_dir_all(parent)
                .map_err(|e| {
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
            fs::remove_file(&models_dir)
                .map_err(|e| {
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
    fs::create_dir_all(&models_dir)
        .map_err(|e| {
            let error_msg = format!("Failed to create models directory '{}': {}", models_dir.display(), e);
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

async fn download_file_from_huggingface(app_handle: &tauri::AppHandle, repo_id: &str, filename: &str, local_path: &PathBuf, model_id: &str) -> Result<(), String> {
    let url = format!("https://huggingface.co/{}/resolve/main/{}", repo_id, filename);
    println!("Downloading {} from {}", filename, url);
    
    let client = reqwest::Client::new();
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to send request: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("HTTP error {}: {}", response.status(), response.status().canonical_reason().unwrap_or("Unknown")));
    }
    
    let total_size = response.content_length().unwrap_or(0);
    println!("File size: {} bytes", total_size);
    
    let mut file = fs::File::create(local_path)
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
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
            
            if downloaded % (1024 * 1024) == 0 || downloaded == total_size { // Log every MB or at completion
                println!("Progress: {:.1}% ({}/{} bytes)", progress, downloaded, total_size);
            }
        }
    }
    
    println!("Successfully downloaded {} ({} bytes)", filename, downloaded);
    Ok(())
}

#[tauri::command]
pub async fn whisper_download_model(app_handle: tauri::AppHandle, model: String) -> Result<bool, String> {
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
    println!("Model info: id={}, repo_id={}, files={:?}", model_id, repo_id, files_to_download);
    
    // Get model path
    let model_path = match get_model_path(&app_handle, model_id) {
        Ok(path) => {
            println!("Model path: {:?}", path);
            path
        },
        Err(e) => {
            println!("ERROR: Failed to get model path: {}", e);
            return Err(e);
        }
    };

    // Create model directory
    if !model_path.exists() {
        println!("Creating model directory: {:?}", model_path);
        fs::create_dir_all(&model_path)
            .map_err(|e| {
                let error_msg = format!("Failed to create model directory '{}': {}", model_path.display(), e);
                println!("ERROR: {}", error_msg);
                error_msg
            })?;
        println!("Model directory created successfully");
    } else {
        println!("Model directory already exists");
    }

    println!("Downloading {} files from Hugging Face...", files_to_download.len());

    // Download each file
    for (i, filename) in files_to_download.iter().enumerate() {
        let local_path = model_path.join(filename);
        println!("Processing file {}/{}: {} -> {:?}", i + 1, files_to_download.len(), filename, local_path);
        
        // Skip if file already exists and is not empty
        if local_path.exists() {
            let file_size = fs::metadata(&local_path)
                .map(|m| m.len())
                .unwrap_or(0);
            if file_size > 0 {
                println!("File {} already exists ({} bytes), skipping", filename, file_size);
                continue;
            } else {
                println!("File {} exists but is empty, re-downloading", filename);
            }
        }

        // Download the file
        match download_file_from_huggingface(&app_handle, repo_id, filename, &local_path, model_id).await {
            Ok(()) => {
                println!("Successfully downloaded file: {}", filename);
            },
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
pub async fn whisper_is_model_downloaded(app_handle: tauri::AppHandle, model: String) -> Result<bool, String> {
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
        let file_size = fs::metadata(&file_path)
            .map(|m| m.len())
            .unwrap_or(0);
        
        if file_size == 0 {
            return Ok(false);
        }
        
        // For model.safetensors, expect significant size (at least 10MB for tiny model)
        if *file == "model.safetensors" && file_size < 10_000_000 {
            return Ok(false);
        }
    }

    Ok(true)
}

#[tauri::command]
pub async fn whisper_get_downloaded_models(app_handle: tauri::AppHandle) -> Result<Vec<String>, String> {
    let models_dir = get_models_dir(&app_handle)?;
    let mut downloaded_models = Vec::new();

    if !models_dir.exists() {
        return Ok(downloaded_models);
    }

    let entries = fs::read_dir(&models_dir)
        .map_err(|e| format!("Failed to read models directory: {}", e))?;

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
    _audio_data: Vec<u8>,
    model: String,
    _language: String,
) -> Result<String, String> {
    println!("Starting transcription with model: {}", model);

    // Check if model is downloaded
    if !whisper_is_model_downloaded(app_handle.clone(), model.clone()).await? {
        return Err(format!("Model {} is not downloaded", model));
    }

    let model_path = get_model_path(&app_handle, &model)?;
    
    // Load model configuration
    let config_path = model_path.join("config.json");
    let _config_content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config file: {}", e))?;

    // For now, return a placeholder result
    // In a real implementation, you would:
    // 1. Process the audio data (convert to proper format, resample to 16kHz)
    // 2. Load the Whisper model using candle or another ML framework
    // 3. Run inference
    // 4. Return the transcription result
    
    println!("Transcription request processed - returning placeholder");
    
    // Return empty string to indicate no speech detected (for now)
    Ok("".to_string())
}