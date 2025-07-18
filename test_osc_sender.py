#!/usr/bin/env python3
"""
Test script to verify VRCTalk OSC message sending functionality.
This script sends OSC messages to the test receiver to verify the backend commands work.
"""

import socket
import struct
import time
from datetime import datetime

def encode_osc_string(s):
    """Encode a string in OSC format with null termination and padding."""
    s_bytes = s.encode('utf-8')
    # Null terminate
    s_bytes += b'\x00'
    # Pad to 4-byte boundary
    padding = 4 - (len(s_bytes) % 4)
    if padding != 4:
        s_bytes += b'\x00' * padding
    return s_bytes

def encode_osc_message(address, args):
    """Encode an OSC message."""
    # Encode address
    addr_bytes = encode_osc_string(address)
    
    # Build type tag
    type_tag = ','
    arg_bytes = b''
    
    for arg in args:
        if isinstance(arg, str):
            type_tag += 's'
            arg_bytes += encode_osc_string(arg)
        elif isinstance(arg, int):
            type_tag += 'i'
            arg_bytes += struct.pack('>i', arg)
        elif isinstance(arg, float):
            type_tag += 'f'
            arg_bytes += struct.pack('>f', arg)
        elif isinstance(arg, bool):
            type_tag += 'T' if arg else 'F'
            # No additional bytes for boolean
    
    # Encode type tag
    type_tag_bytes = encode_osc_string(type_tag)
    
    return addr_bytes + type_tag_bytes + arg_bytes

def send_test_message(address, args, target_port=9000):
    """Send a test OSC message to the specified port."""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        message = encode_osc_message(address, args)
        sock.sendto(message, ('127.0.0.1', target_port))
        sock.close()
        
        timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
        print(f"[{timestamp}] ✅ Sent OSC message to port {target_port}")
        print(f"  📍 Address: {address}")
        print(f"  📦 Args: {args}")
        return True
    except Exception as e:
        print(f"❌ Failed to send OSC message: {e}")
        return False

def test_vrchat_osc_messages():
    """Test sending VRChat OSC messages."""
    print("🎵 Testing VRChat OSC Message Sending")
    print("📡 Sending test messages to port 9000...")
    print("-" * 50)
    
    # Test 1: Send typing indicator
    print("Test 1: Typing indicator")
    send_test_message("/chatbox/typing", [True])
    time.sleep(1)
    
    # Test 2: Send chatbox message
    print("\nTest 2: Chatbox message")
    send_test_message("/chatbox/input", ["Hello from VRCTalk test!", True])
    time.sleep(1)
    
    # Test 3: Send another message
    print("\nTest 3: Another message")
    send_test_message("/chatbox/input", ["OSC integration working! 🎉", True])
    time.sleep(1)
    
    # Test 4: Turn off typing indicator
    print("\nTest 4: Turn off typing")
    send_test_message("/chatbox/typing", [False])
    
    print("\n✅ OSC message tests completed!")
    print("Check the OSC test receiver window for captured messages.")

def test_vrchat_listener():
    """Test sending messages to VRCTalk's OSC listener (port 9001)."""
    print("\n🎯 Testing VRCTalk OSC Listener")
    print("📡 Sending VRChat simulation messages to port 9001...")
    print("-" * 50)
    
    # Test 1: Mute status change
    print("Test 1: Mute status - False (unmuted)")
    send_test_message("/avatar/parameters/MuteSelf", [False], 9001)
    time.sleep(1)
    
    # Test 2: Mute status change
    print("\nTest 2: Mute status - True (muted)")
    send_test_message("/avatar/parameters/MuteSelf", [True], 9001)
    time.sleep(1)
    
    # Test 3: Unmute again
    print("\nTest 3: Mute status - False (unmuted again)")
    send_test_message("/avatar/parameters/MuteSelf", [False], 9001)
    
    print("\n✅ VRCTalk listener tests completed!")
    print("Check the VRCTalk app console for any status changes.")

def main():
    print("🚀 VRCTalk OSC Integration Test")
    print("=" * 50)
    
    # Test sending messages to the OSC receiver (simulating VRCTalk -> VRChat)
    test_vrchat_osc_messages()
    
    # Test sending messages to VRCTalk listener (simulating VRChat -> VRCTalk)
    test_vrchat_listener()
    
    print("\n🎉 All OSC tests completed!")
    print("Review the outputs in both the OSC receiver and VRCTalk app.")

if __name__ == "__main__":
    main()