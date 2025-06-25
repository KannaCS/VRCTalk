// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use rosc::encoder;
use rosc::{OscMessage, OscPacket, OscType};
use std::net::{Ipv4Addr, UdpSocket};
use std::thread;
use tauri::AppHandle;
use tauri::Emitter;

static mut LISTENER_STARTED: bool = false;

#[tauri::command]
fn send_typing(address: String, port: String) {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let msg_buf = encoder::encode(&OscPacket::Message(OscMessage {
        addr: "/chatbox/typing".to_string(),
        args: vec![OscType::Bool(true)],
    }))
    .unwrap();

    sock.send_to(&msg_buf, address + ":" + &port).unwrap();
}

#[tauri::command]
fn send_message(msg: String, address: String, port: String) {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    let msg_buf = encoder::encode(&OscPacket::Message(OscMessage {
        addr: "/chatbox/input".to_string(),
        args: vec![OscType::String(msg), OscType::Bool(true)],
    }))
    .unwrap();

    sock.send_to(&msg_buf, address + ":" + &port).unwrap();
}

#[tauri::command]
fn start_vrc_listener(app: AppHandle) {
    unsafe {
        if LISTENER_STARTED {
            return;
        }

        LISTENER_STARTED = true;
    }

    thread::spawn(move || {
        let sock = UdpSocket::bind("127.0.0.1:9001");
        match sock {
            Ok(sock) => {
                println!("Starting OSC listener...");
                let mut buf = [0u8; rosc::decoder::MTU];

                loop {
                    match sock.recv_from(&mut buf) {
                        Ok((size, _)) => {
                            let (_, packet) = rosc::decoder::decode_udp(&buf[..size]).unwrap();

                            match packet {
                                OscPacket::Message(msg) => {
                                    if msg.addr.as_str() == "/avatar/parameters/MuteSelf" {
                                        if let Some(mute) = msg.args.first().unwrap().clone().bool() {
                                            app.emit("vrchat-mute", mute).unwrap();
                                        }
                                    }
                                }
                                OscPacket::Bundle(_) => {
                                    // Handle bundle if needed
                                }
                            }
                        }
                        Err(e) => {
                            println!("Error receiving from socket: {}", e);
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                println!("Error binding to 9001: {:?}", e);
            }
        }
    });
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
            start_vrc_listener
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
