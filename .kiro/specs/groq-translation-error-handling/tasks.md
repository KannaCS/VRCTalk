# Implementation Plan: Groq Translation Error Handling

## Overview

This implementation plan fixes the bug where translation errors are forwarded to VRChat by adding validation and retry logic to the translation processing flow. The approach adds a validation layer in `VRCTalk.tsx` that detects error responses and retries until a valid translation is received or a timeout occurs.

## Tasks

- [x] 1. Create translation validation utility function
  - Add `isValidTranslation` helper function to `VRCTalk.tsx`
  - Implement error pattern detection (check for "(translation failed:" substring)
  - Implement empty/null result detection
  - Implement unchanged translation detection (result === originalText with different languages)
  - Add TypeScript types for validation parameters
  - _Requirements: 1.1, 1.3_

- [ ]* 1.1 Write property test for validation function
  - **Property 1: Error Detection Accuracy**
  - **Validates: Requirements 1.1, 1.3**
  - Generate random strings with/without error patterns
  - Verify validator correctly identifies all error cases
  - Test with empty strings, null values, and unchanged translations

- [ ]* 1.2 Write unit tests for validation edge cases
  - Test specific error pattern: `"text (translation failed: error)"`
  - Test empty string and null values
  - Test unchanged translation with different languages
  - Test valid translation passes validation
  - _Requirements: 1.1, 1.3_

- [x] 2. Add retry configuration constants
  - Define `TRANSLATION_RETRY_DELAY_MS = 2000` constant
  - Define `TRANSLATION_TIMEOUT_MS = 30000` constant
  - Add comments explaining retry behavior
  - _Requirements: 2.4, 5.1_

- [x] 3. Modify translation processing loop with validation and retry
  - [x] 3.1 Add timeout tracking to processTranslation function
    - Create start timestamp before translation attempts
    - Calculate elapsed time after each attempt
    - _Requirements: 5.1_
  
  - [x] 3.2 Wrap existing translation logic in validation retry loop
    - Add outer while loop that continues until valid translation or timeout
    - Call existing translation logic (3-attempt retry with API fallback)
    - Validate translation result using `isValidTranslation` function
    - _Requirements: 2.1, 2.2_
  
  - [x] 3.3 Implement retry delay between validation failures
    - Add 2-second delay after invalid translation detected
    - Use `await new Promise(r => setTimeout(r, TRANSLATION_RETRY_DELAY_MS))`
    - Log retry attempt with attempt number
    - _Requirements: 2.4_
  
  - [x] 3.4 Implement timeout handling
    - Check if elapsed time exceeds `TRANSLATION_TIMEOUT_MS`
    - Log warning with original text and timeout details
    - Skip message forwarding and release queue lock
    - Continue to next queued message
    - _Requirements: 5.1, 5.2_
  
  - [x] 3.5 Update VRChat forwarding to only send valid translations
    - Only call `invoke("send_message")` when validation passes
    - Skip forwarding entirely for error responses or timeouts
    - Preserve existing message formatting logic for valid translations
    - _Requirements: 3.1, 3.3_

- [ ]* 3.6 Write property test for retry behavior
  - **Property 2: Retry Until Success**
  - **Validates: Requirements 2.1, 2.2, 2.4**
  - Mock translator to fail N times (random 1-5) then succeed
  - Verify system retries exactly N times
  - Verify delays between retries are approximately 2 seconds

- [ ]* 3.7 Write property test for VRChat forwarding correctness
  - **Property 3: VRChat Message Correctness**
  - **Validates: Requirements 3.1, 3.3**
  - Generate random mix of valid and error translation results
  - Mock VRChat sender to track all calls
  - Verify only valid translations are forwarded
  - Verify error responses never reach VRChat sender

- [ ]* 3.8 Write property test for queue continuation
  - **Property 4: Queue Continuation After Timeout**
  - **Validates: Requirements 5.1, 5.2**
  - Generate random queue of messages
  - Make random messages timeout
  - Verify all non-timeout messages are eventually processed
  - Verify queue never deadlocks

- [x] 4. Add comprehensive logging
  - [x] 4.1 Log error detection events
    - Log when error pattern is detected in translation result
    - Log when empty/null result is detected
    - Log when unchanged translation is detected
    - Include error details in log messages
    - _Requirements: 6.1_
  
  - [x] 4.2 Log retry attempts
    - Log each retry attempt with attempt number
    - Log reason for retry (which validation failed)
    - Log successful translation after retries with retry count
    - _Requirements: 6.2, 6.3_
  
  - [x] 4.3 Log timeout events
    - Log warning when timeout is reached
    - Include original text and elapsed time in log
    - Log that message is being skipped
    - _Requirements: 6.4_

- [ ]* 4.4 Write unit tests for logging behavior
  - Mock logger functions
  - Verify error detection logs are called with correct parameters
  - Verify retry logs include attempt numbers
  - Verify timeout logs include original text

- [x] 5. Checkpoint - Ensure all tests pass
  - Run all unit tests and verify they pass
  - Run all property tests with 100 iterations each
  - Verify no regressions in existing translation functionality
  - Test with actual Groq API to verify error handling works in practice
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The fix maintains backward compatibility with existing translation flows
- Existing 3-attempt retry logic in VRCTalk.tsx is preserved
- The validation layer adds an outer retry loop around existing logic
- Property tests should use fast-check library with minimum 100 iterations
- All logging uses existing `@tauri-apps/plugin-log` functions (info, warn, error)
