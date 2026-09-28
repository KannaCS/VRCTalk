# VRCTalk

VRCTalk is a desktop application that provides real-time speech recognition and translation for VRChat. It allows you to speak in your native language while having your words translated and sent to the VRChat chatbox automatically.

## Features

- **Real-time speech recognition** using Web Speech API or Whisper
  - **Web Speech API**: Fast, cloud-based (requires internet)
  - **Whisper**: Offline capable, local processing, high accuracy
- **Translation** between multiple languages via Google Translate, Gemini, or Groq
- **Direct integration** with VRChat's OSC system for chatbox messages
- **Configurable typing indicators**
- **Automatic pause** when VRChat is muted
- **Customizable message formatting**

## Installation

1. Download the latest release from the [Releases](https://github.com/KannaCS/VRCTalk/releases) page
2. Install the application by running the installer
3. Launch VRCTalk

## Requirements

- **Windows 10 or newer**
- **For Web Speech API (default)**:
  - ✅ **Internet connection required** - Audio is processed on Google's servers
  - Low CPU/RAM usage
  - Fast response time
- **For Whisper (optional, offline)**:
  - ❌ Internet NOT required - Runs completely offline
  - Higher CPU/RAM usage (GPU recommended for larger models)
  - Excellent accuracy across 100+ languages
- **For Translation**: Internet connection required for Google Translate, Gemini, and Groq
- **VRChat** with OSC enabled

> **⚠️ Important**: The default Web Speech API requires internet to function. If you need offline speech recognition, switch to Whisper in the Settings.

## Usage

1. Start VRChat and ensure OSC is enabled
2. Launch VRCTalk
3. Configure your source and target languages
4. **Ensure internet connection** (if using Web Speech API - default)
5. Start speaking - your translated messages will appear in the VRChat chatbox

### Troubleshooting Network Errors

If you see **"Network error"** messages:
- Check your internet connection (Web Speech API requires internet)
- **OR** Switch to Whisper for offline speech recognition (Settings → Speech Recognition Engine → Whisper)

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed solutions.

## Configuration

### Speech Recognition

- **Choose recognition engine**:
  - **Web Speech API** (default): Fast, requires internet
  - **Whisper**: Offline capable, choose model size (tiny/base/small/medium/large)
- Select your source language
- Choose microphone input device

### VRChat Settings

- Configure OSC address and port
- Choose message format options
- Enable/disable translation when muted

### Language Settings

- Question mark handling for Japanese

## Development

This application is built with:

- [Tauri](https://tauri.app/) - Desktop application framework
- [TypeScript](https://www.typescriptlang.org/) - Type-safe JavaScript
- [Rust](https://www.rust-lang.org/) - Backend processing and OSC integration

### Building from Source

```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

## License

See the [LICENSE](LICENSE) file for details.
