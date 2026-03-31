# Design Document: Groq Translation Error Handling

## Overview

This design addresses the bug where translation errors from the Groq API are forwarded to VRChat instead of being retried. The solution involves two main components:

1. **Error Detection Logic**: Add validation in `VRCTalk.tsx` to detect when a translation result is an error response
2. **Retry Loop**: Implement a retry mechanism that continues attempting translation until a valid result is received or a timeout occurs

The design maintains backward compatibility with existing translation flows while adding robust error handling that prevents error messages from reaching VRChat users.

## Architecture

The fix follows a layered approach:

```
┌─────────────────────────────────────────┐
│   Speech Recognition (unchanged)        │
└──────────────┬──────────────────────────┘
               │ text
               ▼
┌─────────────────────────────────────────┐
│   Translation Queue (unchanged)         │
└──────────────┬──────────────────────────┘
               │ queued text
               ▼
┌─────────────────────────────────────────┐
│   Translation Processing Loop           │
│   (VRCTalk.tsx - MODIFIED)              │
│                                          │
│   ┌──────────────────────────────────┐  │
│   │ 1. Call translator function      │  │
│   └────────────┬─────────────────────┘  │
│                │                         │
│                ▼                         │
│   ┌──────────────────────────────────┐  │
│   │ 2. Validate result               │  │ ◄── NEW
│   │    - Check for error patterns    │  │
│   │    - Check for empty/null        │  │
│   └────────────┬─────────────────────┘  │
│                │                         │
│         ┌──────┴──────┐                 │
│         │             │                 │
│    Valid Result   Error Result          │
│         │             │                 │
│         │             ▼                 │
│         │   ┌─────────────────────┐    │
│         │   │ 3. Retry with delay │    │ ◄── NEW
│         │   └─────────┬───────────┘    │
│         │             │                 │
│         │             └─────┐           │
│         │                   │           │
│         ▼                   ▼           │
│   ┌──────────────────────────────────┐  │
│   │ 4. Format & send to VRChat       │  │
│   └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│   VRChat OSC (unchanged)                │
└─────────────────────────────────────────┘
```

**Key Design Decisions:**

1. **Validation at the VRChat Forwarder Level**: Error detection happens in `VRCTalk.tsx` rather than modifying `groq_translate.ts`. This allows the fix to work with all translators (Groq, Gemini, Google) and keeps the translator functions focused on their core responsibility.

2. **Infinite Retry with Timeout**: The system will retry indefinitely until either a valid translation is received or a timeout (30 seconds) is reached. This ensures users never see error messages while preventing infinite loops.

3. **Preserve Existing Retry Logic**: The existing 3-attempt retry loop in `VRCTalk.tsx` remains intact. The new validation layer wraps around this, adding an outer retry loop for error responses.

## Components and Interfaces

### 1. Translation Result Validator

A new utility function that determines if a translation result is valid or an error.

**Function Signature:**
```typescript
function isValidTranslation(
  result: string,
  originalText: string,
  sourceLanguage: string,
  targetLanguage: string
): boolean
```

**Validation Rules:**
- Returns `false` if result contains "(translation failed:"
- Returns `false` if result is empty or only whitespace
- Returns `false` if result exactly matches originalText and languages differ
- Returns `true` otherwise

**Location:** `src/components/VRCTalk.tsx` (new helper function)

### 2. Enhanced Translation Processing Loop

The existing `processTranslation` function in `VRCTalk.tsx` will be modified to add validation and retry logic.

**Current Flow:**
```typescript
async function processTranslation() {
  // 1. Get text from queue
  // 2. Try translation (3 attempts with existing retry)
  // 3. Format message
  // 4. Send to VRChat
  // 5. Unlock queue
}
```

**New Flow:**
```typescript
async function processTranslation() {
  // 1. Get text from queue
  // 2. Start timeout timer (30 seconds)
  // 3. Loop until valid translation or timeout:
  //    a. Try translation (3 attempts with existing retry)
  //    b. Validate result
  //    c. If invalid, wait 2 seconds and retry
  //    d. If timeout reached, log error and skip message
  // 4. If valid translation received:
  //    a. Format message
  //    b. Send to VRChat
  // 5. Unlock queue
}
```

### 3. Retry Delay Configuration

**Constants:**
```typescript
const TRANSLATION_RETRY_DELAY_MS = 2000;  // Wait 2 seconds between retry iterations
const TRANSLATION_TIMEOUT_MS = 30000;     // Give up after 30 seconds
```

These constants control the retry behavior and can be adjusted based on real-world performance.

## Data Models

### Translation Result States

The translation result can be in one of three states:

```typescript
type TranslationState = 
  | { status: 'success', translation: string }
  | { status: 'error', errorMessage: string }
  | { status: 'timeout', originalText: string };
```

However, since we're working with existing code that returns strings, we'll use the validation function to determine state rather than changing return types.

### Error Patterns

Error responses from `groq_translate.ts` follow this pattern:
```
"${originalText} (translation failed: ${errorMessage})"
```

The validator will detect this pattern using string matching:
```typescript
result.includes('(translation failed:')
```

## Correctness Properties


*A property is a characteristic or behavior that should hold true across all valid executions of a system—essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Error Detection Accuracy

*For any* translation result string and original text pair, the validation function should correctly identify error responses by detecting the "(translation failed:" pattern, empty/null results, or unchanged translations when languages differ.

**Validates: Requirements 1.1, 1.3**

### Property 2: Retry Until Success

*For any* translation request that initially fails, the system should continue retrying with appropriate delays (2 seconds between iterations) until either a valid translation is received or the timeout (30 seconds) is reached.

**Validates: Requirements 2.1, 2.2, 2.4**

### Property 3: VRChat Message Correctness

*For any* translation processing cycle, if the final result is an error response or timeout, then no message should be sent to VRChat; if the final result is a valid translation, then exactly that valid translation (formatted appropriately) should be sent to VRChat.

**Validates: Requirements 3.1, 3.3**

### Property 4: Queue Continuation After Timeout

*For any* translation request that times out after 30 seconds, the system should release the queue lock and continue processing the next queued message without blocking.

**Validates: Requirements 5.1, 5.2**

## Error Handling

### Translation Validation Errors

**Error Type:** Invalid translation result detected

**Handling:**
- Log the error details (error pattern found, empty result, or unchanged text)
- Increment retry counter
- Wait for retry delay (2 seconds)
- Attempt translation again
- Do not forward to VRChat

**Recovery:** Automatic retry until valid result or timeout

### Timeout Errors

**Error Type:** Translation timeout after 30 seconds

**Handling:**
- Log warning with original text and timeout details
- Skip the current message (do not forward to VRChat)
- Release queue lock
- Continue processing next message in queue

**Recovery:** Message is dropped, but system continues operating normally

### Network Offline Errors

**Error Type:** Network connectivity lost

**Handling:**
- Existing code already checks `navigator.onLine` before processing
- Skip translation processing when offline
- Resume when connectivity is restored

**Recovery:** Automatic resume when network is available

### Translator Function Errors

**Error Type:** Exception thrown by translator function

**Handling:**
- Existing try-catch in the 3-attempt loop handles this
- Error is caught and retry logic applies
- If all 3 attempts fail, result will be an error string
- New validation layer will detect error string and retry at outer level

**Recovery:** Multi-level retry (inner 3-attempt loop + outer validation retry)

## Testing Strategy

### Unit Tests

Unit tests will focus on specific examples and edge cases:

1. **Validation Function Tests:**
   - Test with error pattern: `"Hello (translation failed: API error)"`
   - Test with empty string: `""`
   - Test with null: `null`
   - Test with unchanged text: `originalText === result` with different languages
   - Test with valid translation: `"Hola"` when translating "Hello"

2. **Timeout Behavior Tests:**
   - Mock translator to always fail
   - Verify timeout occurs after 30 seconds
   - Verify queue lock is released after timeout

3. **Queue Continuation Tests:**
   - Add multiple messages to queue
   - Make first message timeout
   - Verify second message is processed

4. **Integration Tests:**
   - Test full flow with mocked translator that fails then succeeds
   - Verify VRChat sender receives only valid translations
   - Verify retry delays are applied

### Property-Based Tests

Property tests will verify universal correctness across many generated inputs. Each property test should run a minimum of 100 iterations.

1. **Property Test for Error Detection (Property 1):**
   - Generate random strings with and without error patterns
   - Generate random original text and translation pairs
   - Verify validator correctly identifies all error cases
   - **Tag:** Feature: groq-translation-error-handling, Property 1: Error Detection Accuracy

2. **Property Test for Retry Behavior (Property 2):**
   - Mock translator to fail N times (random N from 1-5) then succeed
   - Verify system retries exactly N times before success
   - Verify delays between retries are approximately 2 seconds
   - **Tag:** Feature: groq-translation-error-handling, Property 2: Retry Until Success

3. **Property Test for VRChat Forwarding (Property 3):**
   - Generate random translation results (mix of valid and error responses)
   - Mock VRChat sender to track all calls
   - Verify only valid translations are forwarded
   - Verify error responses never reach VRChat sender
   - **Tag:** Feature: groq-translation-error-handling, Property 3: VRChat Message Correctness

4. **Property Test for Queue Continuation (Property 4):**
   - Generate random queue of messages
   - Make random messages timeout
   - Verify all non-timeout messages are eventually processed
   - Verify queue never deadlocks
   - **Tag:** Feature: groq-translation-error-handling, Property 4: Queue Continuation After Timeout

### Testing Framework

- **Unit Tests:** Jest (existing test framework for the project)
- **Property-Based Tests:** fast-check (TypeScript property-based testing library)
- **Mocking:** Jest mocks for translator functions and VRChat sender

### Test Configuration

```typescript
// fast-check configuration for property tests
fc.configureGlobal({
  numRuns: 100,  // Minimum 100 iterations per property test
  verbose: true,
  seed: Date.now()
});
```

### Coverage Goals

- 100% coverage of new validation function
- 100% coverage of modified retry logic in processTranslation
- All 4 correctness properties must pass with 100 iterations
- All edge cases (empty, null, timeout) must be covered by unit tests
