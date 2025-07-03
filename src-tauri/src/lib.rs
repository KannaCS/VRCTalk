// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use rosc::encoder;
use rosc::{OscMessage, OscPacket, OscType};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use tauri::AppHandle;
use tauri::Emitter;

mod whisper;
use whisper::*;

static LISTENER_STARTED: AtomicBool = AtomicBool::new(false);

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
                                                    if msg.addr.as_str() == "/avatar/parameters/MuteSelf" {
                                                        if let Some(arg) = msg.args.first() {
                                                            if let Some(mute) = arg.clone().bool() {
                                                                let _ = app.emit("vrchat-mute", mute);
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
                            
                            // Try to reconnect after a delay
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
        .invoke_handler(tauri::generate_handler![
            send_typing,
            send_message,
            start_vrc_listener,
            whisper_download_model,
            whisper_is_model_downloaded,
            whisper_get_downloaded_models,
            whisper_transcribe
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
