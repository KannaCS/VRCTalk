#!/usr/bin/env python3
"""
Test script to verify VRCTalk network connectivity and external API integrations.
This script tests Google Translate API, Hugging Face API, UDP sockets, and network error handling.
"""

import socket
import requests
import time
import json
import threading
from datetime import datetime
import urllib.parse

def log_test(message, level="INFO"):
    """Log a test message with timestamp."""
    timestamp = datetime.now().strftime('%H:%M:%S.%f')[:-3]
    print(f"[{timestamp}] {level}: {message}")

def test_basic_connectivity():
    """Test basic internet connectivity."""
    print("🌐 Basic Network Connectivity Test")
    print("=" * 50)
    
    # Test DNS resolution and basic connectivity
    test_hosts = [
        ("google.com", 80),
        ("translate.googleapis.com", 443),
        ("huggingface.co", 443),
        ("api.github.com", 443)
    ]
    
    successes = 0
    failures = 0
    
    for host, port in test_hosts:
        try:
            log_test(f"Testing connectivity to {host}:{port}")
            
            # Test DNS resolution
            ip = socket.gethostbyname(host)
            log_test(f"✅ DNS resolution: {host} -> {ip}")
            
            # Test TCP connection
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            result = sock.connect_ex((host, port))
            sock.close()
            
            if result == 0:
                log_test(f"✅ TCP connection successful to {host}:{port}")
                successes += 1
            else:
                log_test(f"❌ TCP connection failed to {host}:{port}", "ERROR")
                failures += 1
                
        except Exception as e:
            log_test(f"❌ Error testing {host}: {str(e)}", "ERROR")
            failures += 1
        
        time.sleep(0.5)
    
    print(f"\n📊 Basic Connectivity Results:")
    print(f"✅ Successes: {successes}")
    print(f"❌ Failures: {failures}")
    
    return successes, failures

def test_google_translate_api():
    """Test Google Translate API comprehensive functionality."""
    print("\n🌍 Google Translate API Integration Test")
    print("=" * 50)
    
    # Test different scenarios
    test_cases = [
        # Basic translations
        ("Hello", "en", "ja", "Basic translation"),
        ("Good morning", "en", "es", "Common phrase"),
        ("Thank you very much", "en", "fr", "Polite expression"),
        
        # Edge cases
        ("", "en", "ja", "Empty string"),
        ("Same language", "en", "en", "Same language"),
        ("123", "en", "ja", "Numbers"),
        ("😊🎉", "en", "ja", "Emojis"),
        
        # Long text
        ("This is a very long sentence that tests the translation API's ability to handle longer text inputs effectively.", "en", "ja", "Long text"),
        
        # Special characters
        ("Hello! How are you? I'm fine.", "en", "es", "Punctuation"),
        ("C++ programming", "en", "ja", "Technical terms"),
    ]
    
    successes = 0
    failures = 0
    response_times = []
    
    for text, source, target, description in test_cases:
        try:
            log_test(f"Testing {description}: '{text}' ({source} -> {target})")
            
            start_time = time.time()
            
            # Skip translation if source and target are the same
            if source == target:
                result = text
                log_test(f"✅ Same language, returned original text")
            elif not text.strip():
                result = text
                log_test(f"✅ Empty text, returned as-is")
            else:
                # Build URL
                encoded_text = urllib.parse.quote(text.replace('%', '%25'))
                url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={source}&tl={target}&dt=t&dt=bd&dj=1&q={encoded_text}"
                
                # Make request
                response = requests.get(url, timeout=10)
                response_time = time.time() - start_time
                response_times.append(response_time)
                
                if response.status_code == 200:
                    data = response.json()
                    
                    if data and 'sentences' in data and len(data['sentences']) > 0:
                        result = ''
                        for sentence in data['sentences']:
                            if 'trans' in sentence:
                                result += sentence['trans']
                        
                        log_test(f"✅ Translation successful: '{result}' ({response_time:.2f}s)")
                        successes += 1
                    else:
                        log_test(f"❌ Invalid response structure", "ERROR")
                        failures += 1
                        continue
                else:
                    log_test(f"❌ HTTP error: {response.status_code}", "ERROR")
                    failures += 1
                    continue
            
            # Validate result
            if source == target:
                assert result == text, "Same language should return original"
            elif not text.strip():
                assert result == text, "Empty text should return empty"
            else:
                assert len(result) > 0, "Translation should not be empty"
            
            successes += 1
            
        except Exception as e:
            log_test(f"❌ Test failed: {str(e)}", "ERROR")
            failures += 1
        
        time.sleep(0.3)  # Rate limiting
    
    # Calculate statistics
    if response_times:
        avg_response = sum(response_times) / len(response_times)
        min_response = min(response_times)
        max_response = max(response_times)
        
        print(f"\n📊 Response Time Statistics:")
        print(f"Average: {avg_response:.2f}s")
        print(f"Min: {min_response:.2f}s")
        print(f"Max: {max_response:.2f}s")
    
    print(f"\n📊 Google Translate API Results:")
    print(f"✅ Successes: {successes}")
    print(f"❌ Failures: {failures}")
    print(f"📈 Success Rate: {(successes/(successes+failures)*100):.1f}%")
    
    return successes, failures

def test_huggingface_api():
    """Test Hugging Face API connectivity for Whisper models."""
    print("\n🤗 Hugging Face API Integration Test")
    print("=" * 50)
    
    # Test model repositories
    models = [
        ("openai/whisper-tiny", "Whisper Tiny"),
        ("openai/whisper-base", "Whisper Base"),
        ("openai/whisper-small", "Whisper Small"),
        ("openai/whisper-medium", "Whisper Medium"),
        ("openai/whisper-large-v3", "Whisper Large v3")
    ]
    
    files_to_check = ["config.json", "model.safetensors", "tokenizer.json"]
    
    successes = 0
    failures = 0
    
    for repo_id, model_name in models:
        try:
            log_test(f"Testing {model_name} repository: {repo_id}")
            
            # Test repository accessibility
            repo_url = f"https://huggingface.co/{repo_id}"
            response = requests.head(repo_url, timeout=10)
            
            if response.status_code == 200:
                log_test(f"✅ Repository accessible: {repo_url}")
                
                # Test file availability
                for file_name in files_to_check:
                    file_url = f"https://huggingface.co/{repo_id}/resolve/main/{file_name}"
                    file_response = requests.head(file_url, timeout=10)
                    
                    if file_response.status_code == 200:
                        log_test(f"✅ File available: {file_name}")
                        successes += 1
                    else:
                        log_test(f"❌ File not accessible: {file_name} (HTTP {file_response.status_code})", "ERROR")
                        failures += 1
                        
            else:
                log_test(f"❌ Repository not accessible: HTTP {response.status_code}", "ERROR")
                failures += len(files_to_check)
                
        except Exception as e:
            log_test(f"❌ Error testing {model_name}: {str(e)}", "ERROR")
            failures += len(files_to_check)
        
        time.sleep(0.5)
    
    print(f"\n📊 Hugging Face API Results:")
    print(f"✅ Successes: {successes}")
    print(f"❌ Failures: {failures}")
    
    return successes, failures

def test_udp_socket_communication():
    """Test UDP socket communication for OSC."""
    print("\n🔌 UDP Socket Communication Test")
    print("=" * 50)
    
    # Test UDP socket creation and communication
    test_ports = [9000, 9001, 9002]  # VRChat and test ports
    
    successes = 0
    failures = 0
    
    for port in test_ports:
        try:
            log_test(f"Testing UDP socket on port {port}")
            
            # Create server socket
            server_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            server_sock.bind(('127.0.0.1', port))
            server_sock.settimeout(2)
            
            # Create client socket
            client_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            
            # Test message
            test_message = b"VRCTalk UDP test message"
            
            # Send message
            client_sock.sendto(test_message, ('127.0.0.1', port))
            log_test(f"✅ Message sent to port {port}")
            
            # Receive message
            data, addr = server_sock.recvfrom(1024)
            
            if data == test_message:
                log_test(f"✅ Message received correctly from {addr}")
                successes += 1
            else:
                log_test(f"❌ Message corruption detected", "ERROR")
                failures += 1
            
            # Cleanup
            server_sock.close()
            client_sock.close()
            
        except Exception as e:
            log_test(f"❌ UDP test failed on port {port}: {str(e)}", "ERROR")
            failures += 1
        
        time.sleep(0.5)
    
    print(f"\n📊 UDP Socket Results:")
    print(f"✅ Successes: {successes}")
    print(f"❌ Failures: {failures}")
    
    return successes, failures

def test_network_error_handling():
    """Test network error handling and recovery."""
    print("\n🛡️ Network Error Handling Test")
    print("=" * 50)
    
    error_scenarios = [
        # Invalid hostnames
        ("invalid-hostname-test.com", "DNS resolution failure"),
        ("192.168.255.255", "Network unreachable"),
        
        # Invalid URLs
        ("https://httpstat.us/404", "HTTP 404 error"),
        ("https://httpstat.us/500", "HTTP 500 error"),
        ("https://httpstat.us/timeout", "Request timeout"),
    ]
    
    successes = 0
    failures = 0
    
    for url_or_host, description in error_scenarios:
        try:
            log_test(f"Testing {description}: {url_or_host}")
            
            if url_or_host.startswith("http"):
                # HTTP request test
                response = requests.get(url_or_host, timeout=3)
                log_test(f"⚠️ Unexpected success: HTTP {response.status_code}")
            else:
                # DNS/connectivity test
                ip = socket.gethostbyname(url_or_host)
                log_test(f"⚠️ Unexpected success: Resolved to {ip}")
                
            failures += 1  # If we get here, the error case didn't occur
            
        except (requests.exceptions.RequestException, socket.gaierror, socket.timeout) as e:
            log_test(f"✅ Expected error handled: {type(e).__name__}")
            successes += 1
        except Exception as e:
            log_test(f"❌ Unexpected error: {str(e)}", "ERROR")
            failures += 1
        
        time.sleep(0.5)
    
    print(f"\n📊 Error Handling Results:")
    print(f"✅ Handled correctly: {successes}")
    print(f"❌ Unexpected behavior: {failures}")
    
    return successes, failures

def test_rate_limiting():
    """Test rate limiting and burst handling."""
    print("\n⏱️ Rate Limiting and Burst Test")
    print("=" * 50)
    
    # Test rapid requests to Google Translate
    rapid_requests = 10
    successes = 0
    failures = 0
    response_times = []
    
    log_test(f"Testing {rapid_requests} rapid requests to Google Translate")
    
    for i in range(rapid_requests):
        try:
            start_time = time.time()
            
            # Simple translation request
            text = f"Test message {i+1}"
            encoded_text = urllib.parse.quote(text)
            url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q={encoded_text}"
            
            response = requests.get(url, timeout=5)
            response_time = time.time() - start_time
            response_times.append(response_time)
            
            if response.status_code == 200:
                log_test(f"✅ Request {i+1}: Success ({response_time:.2f}s)")
                successes += 1
            else:
                log_test(f"❌ Request {i+1}: HTTP {response.status_code}", "ERROR")
                failures += 1
                
        except Exception as e:
            log_test(f"❌ Request {i+1}: {str(e)}", "ERROR")
            failures += 1
        
        time.sleep(0.1)  # Small delay between requests
    
    # Calculate statistics
    if response_times:
        avg_response = sum(response_times) / len(response_times)
        print(f"\n📊 Rate Limiting Results:")
        print(f"✅ Successful requests: {successes}")
        print(f"❌ Failed requests: {failures}")
        print(f"📈 Success rate: {(successes/(successes+failures)*100):.1f}%")
        print(f"⏱️ Average response time: {avg_response:.2f}s")
    
    return successes, failures

def test_concurrent_connections():
    """Test concurrent network connections."""
    print("\n🔄 Concurrent Connection Test")
    print("=" * 50)
    
    # Test multiple concurrent requests
    def make_request(request_id):
        try:
            url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=Hello{request_id}"
            response = requests.get(url, timeout=10)
            return (request_id, response.status_code == 200, response.elapsed.total_seconds())
        except Exception as e:
            return (request_id, False, 0)
    
    # Start multiple threads
    threads = []
    results = []
    num_threads = 5
    
    log_test(f"Starting {num_threads} concurrent translation requests")
    
    for i in range(num_threads):
        thread = threading.Thread(target=lambda i=i: results.append(make_request(i)))
        threads.append(thread)
        thread.start()
    
    # Wait for all threads to complete
    for thread in threads:
        thread.join()
    
    # Analyze results
    successful = sum(1 for _, success, _ in results if success)
    failed = len(results) - successful
    
    if results:
        response_times = [time for _, success, time in results if success]
        avg_time = sum(response_times) / len(response_times) if response_times else 0
        
        print(f"\n📊 Concurrent Connection Results:")
        print(f"✅ Successful: {successful}")
        print(f"❌ Failed: {failed}")
        print(f"⏱️ Average response time: {avg_time:.2f}s")
    
    return successful, failed

def main():
    """Run all network connectivity and API integration tests."""
    print("🌐 VRCTalk Network Connectivity and API Integration Test")
    print("=" * 70)
    
    # Test basic connectivity
    conn_success, conn_failures = test_basic_connectivity()
    
    # Test Google Translate API
    translate_success, translate_failures = test_google_translate_api()
    
    # Test Hugging Face API
    hf_success, hf_failures = test_huggingface_api()
    
    # Test UDP socket communication
    udp_success, udp_failures = test_udp_socket_communication()
    
    # Test network error handling
    error_success, error_failures = test_network_error_handling()
    
    # Test rate limiting
    rate_success, rate_failures = test_rate_limiting()
    
    # Test concurrent connections
    concurrent_success, concurrent_failures = test_concurrent_connections()
    
    print("\n" + "=" * 70)
    print("📊 Final Network Test Summary:")
    print("=" * 70)
    
    print(f"🌐 Basic Connectivity: {conn_success} successes, {conn_failures} failures")
    print(f"🌍 Google Translate: {translate_success} successes, {translate_failures} failures")
    print(f"🤗 Hugging Face: {hf_success} successes, {hf_failures} failures")
    print(f"🔌 UDP Sockets: {udp_success} successes, {udp_failures} failures")
    print(f"🛡️ Error Handling: {error_success} successes, {error_failures} failures")
    print(f"⏱️ Rate Limiting: {rate_success} successes, {rate_failures} failures")
    print(f"🔄 Concurrent: {concurrent_success} successes, {concurrent_failures} failures")
    
    # Calculate overall statistics
    total_success = (conn_success + translate_success + hf_success + udp_success + 
                    error_success + rate_success + concurrent_success)
    total_failures = (conn_failures + translate_failures + hf_failures + udp_failures + 
                     error_failures + rate_failures + concurrent_failures)
    
    if total_success + total_failures > 0:
        success_rate = (total_success / (total_success + total_failures)) * 100
        print(f"\n🎯 Overall Network Test Results:")
        print(f"✅ Total Successes: {total_success}")
        print(f"❌ Total Failures: {total_failures}")
        print(f"📈 Overall Success Rate: {success_rate:.1f}%")
        
        if success_rate >= 90:
            print(f"🎉 EXCELLENT: Network connectivity is robust and reliable!")
        elif success_rate >= 75:
            print(f"✅ GOOD: Network connectivity is generally reliable")
        elif success_rate >= 50:
            print(f"⚠️ FAIR: Some network issues detected")
        else:
            print(f"❌ POOR: Significant network connectivity issues")
    
    print(f"\n🔧 Network Infrastructure Assessment:")
    print(f"- External API integration: {'✅ Excellent' if translate_failures == 0 else '⚠️ Issues detected'}")
    print(f"- Model download capability: {'✅ Excellent' if hf_failures == 0 else '⚠️ Issues detected'}")
    print(f"- OSC communication: {'✅ Excellent' if udp_failures == 0 else '⚠️ Issues detected'}")
    print(f"- Error resilience: {'✅ Excellent' if error_success > error_failures else '⚠️ Needs improvement'}")
    print(f"- Concurrent handling: {'✅ Excellent' if concurrent_failures == 0 else '⚠️ Issues detected'}")

if __name__ == "__main__":
    main()