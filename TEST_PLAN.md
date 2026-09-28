# VRCTalk Test Plan - Network Error Fix

## Status: Ready for Testing

### Changes Made

1. ✅ **Updated Rust Dependencies (Cargo.toml)**
   - Tauri: 2.6.2 → 2.12.0
   - All plugins updated to match NPM versions
   - Version mismatch should be resolved

2. ✅ **Fixed Network Error Loop (WebSpeech.ts)**
   - Added consecutive network error counter (max 3)
   - Implemented exponential backoff (2s, 4s, 8s delays)
   - Auto-stop after 3 consecutive failures
   - Reset counter on successful connection
   - Better error messages for users

3. ✅ **Documentation Created**
   - TROUBLESHOOTING.md - Complete guide
   - test-webspeech.html - Browser-based diagnostic tool
   - update-dependencies scripts - Safe update process

### Testing Steps

#### Test 1: Version Mismatch (Should be Fixed)
```bash
npm run tauri dev
```
**Expected**: No version mismatch warning should appear

**Actual**: (Fill in after testing)

---

#### Test 2: Web Speech with Internet (Should Work)
**Prerequisites**: Active internet connection

1. Run `npm run tauri dev`
2. Start recognition (default WebSpeech)
3. Speak in Indonesian

**Expected Results**:
- ✅ Recognition starts successfully
- ✅ Text appears as you speak
- ✅ No network errors
- ✅ Translation works

**Actual**: (Fill in after testing)

---

#### Test 3: Web Speech without Internet (Should Fail Gracefully)
**Prerequisites**: Disconnect internet

1. Run `npm run tauri dev`
2. Start recognition
3. Speak in Indonesian

**Expected Results**:
```
[ERROR] Network error occurred (consecutive: 1/3)
[INFO] Will retry in 2000ms...
[ERROR] Network error occurred (consecutive: 2/3)
[INFO] Will retry in 4000ms...
[ERROR] Network error occurred (consecutive: 3/3)
[ERROR] Too many consecutive network errors. Stopping recognition.
[ERROR] Please check your internet connection.
```
- ❌ No infinite loop
- ❌ Stops after 3 attempts
- ✅ Clear error message

**Actual**: (Fill in after testing)

---

#### Test 4: Browser Diagnostic Tool
1. Open `test-webspeech.html` in Chrome/Edge
2. Click "Start Recognition"
3. Speak

**Expected**: 
- With internet: ✅ Works, shows transcript
- Without internet: ❌ Shows network error immediately

**Actual**: (Fill in after testing)

---

#### Test 5: Switch to Whisper (Offline Alternative)
1. Go to Settings
2. Change to Whisper engine
3. Select model (e.g., base)
4. Disconnect internet
5. Speak

**Expected**:
- ✅ Works offline
- ✅ Text appears (slower than WebSpeech)
- ✅ No network errors

**Actual**: (Fill in after testing)

---

### Root Cause Analysis

The network error has **multiple potential causes**:

1. **No Internet Connection** (Most Likely)
   - Web Speech API requires internet to Google servers
   - Network firewall/proxy blocking connection
   - DNS resolution issues

2. **Language Support Issues**
   - Indonesian (`id` or `id-ID`) may have limited support
   - Try testing with `en-US` to compare

3. **Browser/System Issues**
   - Chrome/Edge not updated
   - Antivirus blocking WebRTC/Speech API
   - Microphone permissions not granted

4. **Outdated Dependencies** (Now Fixed)
   - `@types/dom-speech-recognition` was 8 versions behind
   - Tauri packages had version mismatches

### Next Steps

#### If Still Failing After Updates:

1. **Test with English language**:
   - Change source language to `en-US`
   - If works: Indonesian support issue
   - If fails: Internet/browser issue

2. **Use test-webspeech.html**:
   - Isolates whether issue is in VRCTalk or Web Speech API itself
   - Easier to debug in simple environment

3. **Check Browser Console** (in test-webspeech.html):
   - F12 → Console tab
   - Look for detailed error messages
   - Check Network tab for blocked requests

4. **Try Different Browser**:
   - Chrome vs Edge
   - Update to latest version

5. **Switch to Whisper**:
   - If Web Speech consistently fails
   - Whisper is more reliable for offline use
   - Supports Indonesian well

### Performance Comparison

| Metric | Web Speech API | Whisper (base) |
|--------|---------------|----------------|
| Internet Required | ✅ Yes | ❌ No |
| Latency | ~100-300ms | ~1-3s |
| Accuracy (Indonesian) | Good | Excellent |
| CPU Usage | Low | Medium-High |
| RAM Usage | ~50MB | ~500MB |
| Reliability | Dependent on internet | Very stable |

### Recommendations

**For Users WITH stable internet**: 
- Use Web Speech API (default)
- Fast and efficient

**For Users WITHOUT reliable internet**:
- Switch to Whisper
- Download `base` model (recommended)
- Expect slower but more accurate results

**For Best Accuracy (any connection)**:
- Use Whisper `small` or `medium` model
- Requires more powerful PC
- Best for non-English languages

---

## Debug Commands

```bash
# Check if internet is working
ping google.com

# Check current package versions
npm list @tauri-apps/api
cargo tree | grep tauri

# View all logs during dev
npm run tauri dev 2>&1 | tee debug.log

# Test just Vite (frontend)
npm run dev

# Build production
npm run tauri build
```

## Files Changed

- ✅ `src-tauri/Cargo.toml` - Updated Tauri versions
- ✅ `src/recognizers/WebSpeech.ts` - Fixed network error loop
- ✅ `TROUBLESHOOTING.md` - New documentation
- ✅ `test-webspeech.html` - New diagnostic tool
- ✅ `update-dependencies.ps1` - Update script
- ✅ `update-dependencies.sh` - Update script (Linux/Mac)
- ✅ `README.md` - Added internet requirements notice

---

**Test Date**: _____________

**Tester**: _____________

**Results Summary**: _____________
