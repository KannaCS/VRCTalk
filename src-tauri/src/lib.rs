// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use rosc::encoder;
use rosc::{OscMessage, OscPacket, OscType};
#[allow(unused_imports)]
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::AppHandle;
use tauri::Emitter;

mod whisper;
use whisper::*;

static LISTENER_STARTED: AtomicBool = AtomicBool::new(false);
static BRIDGE_STARTED: AtomicBool = AtomicBool::new(false);

// ── Chrome Bridge HTTP server ────────────────────────────────────────────────
// A tiny HTTP server on 127.0.0.1:19421 that:
//   POST /result  — receives transcription from Chrome bridge page
//   POST /status  — receives status updates
//   POST /error   — receives error messages
//   GET  /config  — Chrome polls this for language updates
//
// Results are forwarded to the Tauri frontend via events.

#[derive(Clone)]
struct BridgeState {
    app: AppHandle,
    lang: Arc<Mutex<String>>,
}

fn start_chrome_bridge_server(state: BridgeState) {
    thread::spawn(move || {
        let server = match tiny_http::Server::http("127.0.0.1:19421") {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[BRIDGE] Failed to start HTTP server: {}", e);
                return;
            }
        };
        println!("[BRIDGE] HTTP server listening on 127.0.0.1:19421");

        for mut request in server.incoming_requests() {
            let url = request.url().to_string();
            let method = request.method().to_string();

            match (method.as_str(), url.as_str()) {
                ("POST", "/result") => {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                        let transcript = json["transcript"].as_str().unwrap_or("").to_string();
                        let is_final   = json["isFinal"].as_bool().unwrap_or(false);
                        if !transcript.is_empty() {
                            let _ = state.app.emit("chrome-bridge-result", serde_json::json!({
                                "transcript": transcript,
                                "isFinal": is_final,
                            }));
                        }
                    }
                    let _ = request.respond(tiny_http::Response::from_string("ok"));
                }
                ("POST", "/status") => {
                    let _ = state.app.emit("chrome-bridge-status", "started");
                    let _ = request.respond(tiny_http::Response::from_string("ok"));
                }
                ("POST", "/error") => {
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                        let msg = json["message"].as_str().unwrap_or("unknown").to_string();
                        let _ = state.app.emit("chrome-bridge-error", msg);
                    }
                    let _ = request.respond(tiny_http::Response::from_string("ok"));
                }
                ("GET", "/config") => {
                    let lang = state.lang.lock().unwrap().clone();
                    let body = serde_json::json!({ "lang": lang }).to_string();
                    let response = tiny_http::Response::from_string(body)
                        .with_header("Content-Type: application/json".parse::<tiny_http::Header>().unwrap())
                        .with_header("Access-Control-Allow-Origin: *".parse::<tiny_http::Header>().unwrap());
                    let _ = request.respond(response);
                }
                _ => {
                    // CORS preflight or unknown
                    let response = tiny_http::Response::from_string("")
                        .with_header("Access-Control-Allow-Origin: *".parse::<tiny_http::Header>().unwrap())
                        .with_header("Access-Control-Allow-Methods: GET, POST, OPTIONS".parse::<tiny_http::Header>().unwrap());
                    let _ = request.respond(response);
                }
            }
        }
    });
}

// Shared lang state for the bridge
static BRIDGE_LANG: once_cell::sync::Lazy<Arc<Mutex<String>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new("en-US".to_string())));

#[tauri::command]
fn start_chrome_bridge(app: AppHandle, lang: String) -> Result<(), String> {
    // Update lang regardless of whether server is already running
    *BRIDGE_LANG.lock().unwrap() = lang;

    if BRIDGE_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(()); // server already running
    }

    let state = BridgeState {
        app,
        lang: Arc::clone(&BRIDGE_LANG),
    };
    start_chrome_bridge_server(state);
    Ok(())
}

#[tauri::command]
fn update_bridge_lang(lang: String) -> Result<(), String> {
    *BRIDGE_LANG.lock().unwrap() = lang;
    Ok(())
}

#[tauri::command]
fn get_bridge_html_path() -> Result<String, String> {
    // Return the embedded bridge HTML content directly
    // so the frontend can write it to a temp file
    Ok(include_str!("chrome_bridge.html").to_string())
}

#[tauri::command]
fn send_typing(address: String, port: String) -> Result<(), String> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("Failed to bind socket: {}", e))?;

    let msg_buf = encoder::encode(&OscPacket::Message(OscMessage {
        addr: "/chatbox/typing".to_string(),
        args: vec![OscType::Bool(true)],
    }))
    .map_err(|e| format!("Failed to encode OSC message: {}", e))?;

    let target = format!("{}:{}", address, port);
    sock.send_to(&msg_buf, &target)
        .map_err(|e| format!("Failed to send OSC message: {}", e))?;

    Ok(())
}

#[tauri::command]
fn send_message(msg: String, address: String, port: String) -> Result<(), String> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("Failed to bind socket: {}", e))?;

    let msg_buf = encoder::encode(&OscPacket::Message(OscMessage {
        addr: "/chatbox/input".to_string(),
        args: vec![OscType::String(msg), OscType::Bool(true)],
    }))
    .map_err(|e| format!("Failed to encode OSC message: {}", e))?;

    let target = format!("{}:{}", address, port);
    sock.send_to(&msg_buf, &target)
        .map_err(|e| format!("Failed to send OSC message: {}", e))?;

    Ok(())
}

#[tauri::command]
fn start_vrc_listener(app: AppHandle) -> Result<(), String> {
    // Only start the listener once
    if LISTENER_STARTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    thread::spawn(move || {
        let listen_addr = SocketAddr::from(([127, 0, 0, 1], 9001));
        match UdpSocket::bind(listen_addr) {
            Ok(mut sock) => {
                println!("Starting OSC listener on {}...", listen_addr);
                let _ = app.emit("vrchat-status", "connected");

                let mut buf = [0u8; rosc::decoder::MTU];

                loop {
                    match sock.recv_from(&mut buf) {
                        Ok((size, _)) => {
                            match rosc::decoder::decode_udp(&buf[..size]) {
                                Ok((_, packet)) => {
                                    match packet {
                                        OscPacket::Message(msg) => {
                                            if msg.addr.as_str() == "/avatar/parameters/MuteSelf" {
                                                if let Some(arg) = msg.args.first() {
                                                    if let Some(mute) = arg.clone().bool() {
                                                        let _ = app.emit("vrchat-mute", mute);
                                                    }
                                                }
                                            }
                                        }
                                        OscPacket::Bundle(bundle) => {
                                            // Process messages in bundle
                                            for message in bundle.content {
                                                if let OscPacket::Message(msg) = message {
                                                    if msg.addr.as_str()
                                                        == "/avatar/parameters/MuteSelf"
                                                    {
                                                        if let Some(arg) = msg.args.first() {
                                                            if let Some(mute) = arg.clone().bool() {
                                                                let _ =
                                                                    app.emit("vrchat-mute", mute);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    println!("Error decoding OSC packet: {}", e);
                                }
                            }
                        }
                        Err(e) => {
                            println!("Error receiving from socket: {}", e);
                            let _ = app.emit("vrchat-status", "disconnected");

                            // Drop the old socket BEFORE sleeping so the port is freed,
                            // otherwise the subsequent bind call will fail with
                            // "Address already in use" and permanently kill the listener.
                            drop(sock);
                            thread::sleep(std::time::Duration::from_secs(5));
                            match UdpSocket::bind(listen_addr) {
                                Ok(new_sock) => {
                                    println!("Reconnected OSC listener");
                                    let _ = app.emit("vrchat-status", "connected");
                                    sock = new_sock;
                                }
                                Err(e) => {
                                    println!("Failed to reconnect OSC listener: {}", e);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                let error_msg = format!("Error binding to {}: {}", listen_addr, e);
                println!("{}", error_msg);
                let _ = app.emit("vrchat-status", "error");
                let _ = app.emit("vrchat-error", error_msg);
            }
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        .manage(WhisperAppState {
            state: Arc::new(Mutex::new(None)),
        })
        .invoke_handler(tauri::generate_handler![
            send_typing,
            send_message,
            start_vrc_listener,
            start_chrome_bridge,
            update_bridge_lang,
            get_bridge_html_path,
            whisper_download_model,
            whisper_is_model_downloaded,
            whisper_get_downloaded_models,
            whisper_transcribe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
