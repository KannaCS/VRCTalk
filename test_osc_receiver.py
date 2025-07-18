#!/usr/bin/env python3
"""
Simple OSC receiver to test VRCTalk OSC message sending functionality.
This script listens on port 9000 (where VRChat normally receives OSC messages)
and decodes any OSC messages sent by VRCTalk.
"""

import socket
import struct
import sys
from datetime import datetime

def decode_osc_string(data, offset):
    """Decode OSC string from bytes."""
    end = data.find(b'\x00', offset)
    if end == -1:
        return None, len(data)
    
    string = data[offset:end].decode('utf-8')
    # OSC strings are null-terminated and padded to 4-byte boundary
    padding = 4 - ((end - offset + 1) % 4)
    if padding == 4:
        padding = 0
    return string, end + 1 + padding

def decode_osc_message(data):
    """Decode OSC message from bytes."""
    try:
        # Decode address pattern
        addr, offset = decode_osc_string(data, 0)
        if not addr:
            return None
        
        # Decode type tag string
        type_tag, offset = decode_osc_string(data, offset)
        if not type_tag or not type_tag.startswith(','):
            return None
        
        # Decode arguments
        args = []
        type_chars = type_tag[1:]  # Remove leading comma
        
        for type_char in type_chars:
            if type_char == 's':  # String
                arg, offset = decode_osc_string(data, offset)
                args.append(arg)
            elif type_char == 'i':  # Integer
                arg = struct.unpack('>i', data[offset:offset+4])[0]
                args.append(arg)
                offset += 4
            elif type_char == 'f':  # Float
                arg = struct.unpack('>f', data[offset:offset+4])[0]
                args.append(arg)
                offset += 4
            elif type_char == 'T':  # True
                args.append(True)
            elif type_char == 'F':  # False
                args.append(False)
            else:
                print(f"Unknown type character: {type_char}")
                break
        
        return {
            'address': addr,
            'args': args
        }
    except Exception as e:
        print(f"Error decoding OSC message: {e}")
        return None

def main():
    # Create UDP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(('127.0.0.1', 9000))
    
    print("🎵 OSC Test Receiver started on 127.0.0.1:9000")
    print("📡 Listening for OSC messages from VRCTalk...")
    print("⏹️  Press Ctrl+C to stop")
    print("-" * 50)
    
    try:
        while True:
            data, addr = sock.recvfrom(1024)
            timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
            
            # Decode OSC message
            message = decode_osc_message(data)
            if message:
                print(f"[{timestamp}] 📨 OSC Message from {addr}:")
                print(f"  📍 Address: {message['address']}")
                print(f"  📦 Args: {message['args']}")
                
                # Interpret specific VRChat OSC messages
                if message['address'] == '/chatbox/input':
                    if len(message['args']) >= 2:
                        text = message['args'][0]
                        immediate = message['args'][1]
                        print(f"  💬 Chatbox Input: '{text}' (immediate: {immediate})")
                elif message['address'] == '/chatbox/typing':
                    if message['args']:
                        typing = message['args'][0]
                        print(f"  ⌨️  Typing Status: {typing}")
                        
                print("-" * 50)
            else:
                print(f"[{timestamp}] ❌ Failed to decode OSC message from {addr}")
                print(f"  📊 Raw data: {data.hex()}")
                print("-" * 50)
                
    except KeyboardInterrupt:
        print("\n🛑 OSC Test Receiver stopped.")
    finally:
        sock.close()

if __name__ == "__main__":
    main()