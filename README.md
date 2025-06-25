# VRCTalk

VRCTalk is a desktop application that provides real-time speech recognition and translation for VRChat. It allows you to speak in your native language while having your words translated and sent to the VRChat chatbox automatically.

## Features

- Real-time speech recognition using Web Speech API
- Translation between multiple languages via Google Translate
- Direct integration with VRChat's OSC system for chatbox messages
- Configurable typing indicators
- Automatic pause when VRChat is muted
- Customizable message formatting

## Installation

1. Download the latest release from the [Releases](https://github.com/KannaCS/VRCTalk/releases) page
2. Install the application by running the installer
3. Launch VRCTalk

## Requirements

- Windows 10 or newer
- Internet connection for translation services
- VRChat with OSC enabled

## Usage

1. Start VRChat and ensure OSC is enabled
2. Launch VRCTalk
3. Configure your source and target languages
4. Start speaking - your translated messages will appear in the VRChat chatbox

## Configuration

### Speech Recognition

- Select your source language
- Choose the target language for translation

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
