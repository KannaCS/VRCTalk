# Quick Diagnostic Test

## Step 1: Test Web Speech API Directly

1. Open `test-webspeech.html` in Chrome or Edge browser
2. Make sure language is set to **Indonesian (id-ID)**
3. Click "Start Recognition"
4. Speak something in Indonesian

### Expected Results:

**If it WORKS:**
```
✅ Recognition started successfully
✅ Text appears as you speak
✅ No network errors
```
→ Problem is in VRCTalk code, not Web Speech API

**If it FAILS with network error:**
```
❌ ERROR: network
❌ Cannot connect to Google servers
```
→ Problem is internet/browser/language support

---

## Step 2: Test with English (if Indonesian fails)

1. In `test-webspeech.html`, change language to **English (US)**
2. Click "Start Recognition"  
3. Speak in English

**If English works but Indonesian doesn't:**
→ Indonesian language support issue
→ **Solution: Switch to Whisper in VRCTalk Settings**

---

## Step 3: Check Internet Connection

```bash
# Test Google connectivity
ping google.com

# Test DNS resolution
nslookup google.com
```

**If these fail:**
→ Internet connection problem
→ Firewall/proxy blocking Google

---

## Quick Fix: Switch to Whisper (Offline Mode)

Since Web Speech API requires internet and may not fully support Indonesian:

1. Open VRCTalk
2. Go to **Settings**
3. Change **Speech Recognition Engine** from "WebSpeech" to "Whisper"
4. Select model: **base** (recommended)
5. Click Save
6. Try speaking again

Whisper:
- ✅ Works offline (no internet needed)
- ✅ Excellent Indonesian support
- ✅ More accurate
- ⚠️ Slower (1-3 seconds latency)
- ⚠️ Uses more CPU/RAM

---

## Results

Fill in after testing:

### test-webspeech.html + Indonesian:
- [ ] Works
- [ ] Fails with network error
- [ ] Other: ___________

### test-webspeech.html + English:
- [ ] Works
- [ ] Fails with network error
- [ ] Other: ___________

### Internet Test (ping google.com):
- [ ] Success
- [ ] Timeout/Fail

### Whisper (if tried):
- [ ] Works
- [ ] Fails
- [ ] Not tested

---

## Conclusion

Based on your test results:

**If nothing works (even English + good internet):**
- Browser issue
- Update Chrome/Edge to latest version
- Try different browser

**If Indonesian doesn't work but English does:**
- Language support issue
- **Use Whisper for Indonesian**

**If internet test fails:**
- Fix internet connection first
- Check firewall settings
- **Or use Whisper (offline)**
