# VRCTalk Troubleshooting Guide

## Web Speech API Network Errors

### Symptoms
- Application shows repeated "network error" messages in the console
- Speech recognition doesn't return any text despite audio input
- Error message: `[ERROR] [WEBSPEECH] Network error occurred`
- Recognition eventually stops with: `Too many consecutive network errors`

### Quick Diagnosis

**Before troubleshooting in the app, test Web Speech API directly:**

1. Open `test-webspeech.html` in Chrome/Edge browser
2. Click "Start Recognition"
3. Speak something
4. Check the results:
   - ✅ **If it works**: Problem is in VRCTalk app code
   - ❌ **If network error**: Problem is browser/system/internet

This isolates whether the issue is Web Speech API itself or VRCTalk's implementation.

### Root Causes

**1. No Internet Connection (Most Common)**
Web Speech API requires an active internet connection to function. The browser's Web Speech API (used by Chrome/Edge) sends audio to Google's servers for processing. Without internet, the API cannot transcribe speech.

**2. Outdated Dependencies (Also Common)**
The `@types/dom-speech-recognition` package and other Tauri dependencies may be outdated, causing compatibility issues with modern browsers. This project was found to have dependencies that are several versions behind.

### Solutions

#### Option 0: Update Dependencies First (RECOMMENDED)
Before trying other solutions, update your dependencies as they may be outdated:

**Windows (PowerShell):**
```powershell
.\update-dependencies.ps1
```

**Linux/Mac:**
```bash
bash update-dependencies.sh
```

**Or manually:**
```bash
# Critical updates (safe, no breaking changes)
npm install @types/dom-speech-recognition@latest
npm install @tauri-apps/api@latest @tauri-apps/cli@latest
npm install @tauri-apps/plugin-fs@latest @tauri-apps/plugin-log@latest
npm install @tauri-apps/plugin-opener@latest @tauri-apps/plugin-shell@latest
npm install autoprefixer@latest postcss@latest

# Rebuild and test
npm run tauri dev
```

#### Option 1: Check Your Internet Connection (For Web Speech)
1. Verify you have an active internet connection
2. Test by opening a website in your browser
3. Check if firewall/antivirus is blocking browser network access
4. If behind a corporate firewall, Web Speech API may be blocked

#### Option 2: Switch to Offline Whisper (Recommended for Offline Use)
Whisper runs locally on your computer and does NOT require internet:

1. Open VRCTalk Settings
2. Change **Speech Recognition Engine** from "WebSpeech" to "Whisper"
3. Select a Whisper model (recommended: `base` for balance of speed and accuracy)
4. Click Save

**Whisper Model Recommendations:**
- `tiny` - Fastest, lowest accuracy (good for testing)
- `base` - **Recommended** - Good balance
- `small` - Better accuracy, slower
- `medium/large` - Best accuracy, requires powerful GPU

### Comparison: Web Speech vs Whisper

| Feature | Web Speech API | Whisper |
|---------|---------------|---------|
| Internet Required | ✅ **Yes - Must be online** | ❌ No - Works offline |
| Speed | Very Fast | Slower (depends on model) |
| Accuracy | Good | Excellent |
| Language Support | Limited | 100+ languages |
| Resource Usage | Low (cloud-based) | High (local processing) |
| Privacy | Audio sent to Google | Audio stays on your PC |

### Why Web Speech Needs Internet

The Web Speech API is a browser feature that:
1. Captures audio from your microphone
2. Sends it to Google's servers via the internet
3. Receives transcribed text back
4. Returns the text to the application

Without internet, step 2 and 3 cannot happen, causing network errors.

### Additional Troubleshooting

#### If Whisper Also Fails
- Check if Whisper models are downloaded (see Settings)
- Ensure your PC meets minimum requirements (4GB+ RAM)
- Try a smaller model (`tiny` or `base`)

#### If Microphone Not Working
1. Check Windows Sound Settings
2. Set correct microphone as default input device
3. Grant microphone permission to the application
4. Test microphone in Windows Voice Recorder

#### Still Having Issues?
1. Check the full logs in the console output
2. Report issues at: [Your GitHub Issues Page]
3. Include:
   - Operating System
   - Speech Recognition Engine (WebSpeech/Whisper)
   - Internet connection status
   - Full error logs

## Other Common Issues

### OSC Connection Issues
If VRChat OSC is not connecting:
- Ensure VRChat is running
- Check that OSC is enabled in VRChat settings
- Default port is 9001

### Translation Fails
- Ensure internet connection for Google Translate and Gemini
- Verify API keys for Gemini/Groq are valid
- Check source and target languages are supported

---

**Note:** This application defaults to Web Speech API which requires internet. For offline use, switch to Whisper in Settings.
