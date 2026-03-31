# Requirements Document

## Introduction

This specification addresses a critical bug in the Groq translation system where error messages and failed translation responses are being forwarded to VRChat instead of being retried. Currently, when the Groq API returns an error or null response, the system appends "(translation failed: error message)" to the original text and forwards this error message to VRChat, resulting in users seeing error messages in their chatbox instead of translations.

The fix will ensure that translation errors trigger retries until a valid response is received, and that no error messages are ever forwarded to VRChat.

## Glossary

- **Groq_Translator**: The translation module that interfaces with the Groq API (`src/translators/groq_translate.ts`)
- **VRChat_Forwarder**: The component responsible for sending translated messages to VRChat via OSC (`src/components/VRCTalk.tsx`)
- **Translation_Result**: The string returned by a translation function, which may be a valid translation or an error message
- **Error_Response**: A translation result that contains error indicators such as "(translation failed:" substring
- **Valid_Translation**: A translation result that does not contain error indicators and represents actual translated text
- **Retry_Attempt**: A single attempt to obtain a valid translation from the translation API

## Requirements

### Requirement 1: Detect Translation Errors

**User Story:** As a developer, I want the system to detect when a translation has failed, so that error responses are not treated as valid translations.

#### Acceptance Criteria

1. WHEN a Translation_Result contains the substring "(translation failed:", THEN THE VRChat_Forwarder SHALL identify it as an Error_Response
2. WHEN a Translation_Result is empty or null, THEN THE VRChat_Forwarder SHALL identify it as an Error_Response
3. WHEN a Translation_Result matches the original input text exactly and source language differs from target language, THEN THE VRChat_Forwarder SHALL identify it as a potential Error_Response

### Requirement 2: Retry Failed Translations

**User Story:** As a user, I want the system to automatically retry failed translations, so that I receive valid translations instead of error messages.

#### Acceptance Criteria

1. WHEN THE VRChat_Forwarder receives an Error_Response, THEN THE System SHALL retry the translation request
2. WHEN a Retry_Attempt fails, THEN THE System SHALL continue retrying until a Valid_Translation is received
3. WHEN retrying a translation, THEN THE System SHALL use the same retry mechanism as the initial translation attempt (3 attempts with API key fallback)
4. WHEN all Retry_Attempts within a single iteration fail, THEN THE System SHALL wait a brief period before the next retry iteration

### Requirement 3: Prevent Error Message Forwarding

**User Story:** As a VRChat user, I want to never see error messages in my chatbox, so that my communication experience is not disrupted by technical failures.

#### Acceptance Criteria

1. WHEN THE VRChat_Forwarder receives an Error_Response, THEN THE System SHALL NOT send any message to VRChat
2. WHEN THE VRChat_Forwarder is retrying a translation, THEN THE System SHALL maintain the typing indicator in VRChat
3. WHEN a Valid_Translation is received after retries, THEN THE System SHALL forward only the Valid_Translation to VRChat

### Requirement 4: Maintain Translation Quality

**User Story:** As a user, I want the system to validate translation quality, so that I receive meaningful translations.

#### Acceptance Criteria

1. WHEN a Translation_Result is received, THEN THE System SHALL verify it does not contain error indicators before forwarding
2. WHEN a Translation_Result is identical to the source text and languages differ, THEN THE System SHALL treat it as a potential failure and retry
3. WHEN a Valid_Translation is confirmed, THEN THE System SHALL forward it using the existing message formatting logic

### Requirement 5: Graceful Degradation

**User Story:** As a user, I want the system to handle persistent failures gracefully, so that the application remains responsive even when translation services are unavailable.

#### Acceptance Criteria

1. WHEN translation retries exceed a reasonable timeout period (e.g., 30 seconds), THEN THE System SHALL log the persistent failure
2. WHEN a persistent failure occurs, THEN THE System SHALL skip forwarding that specific message and continue processing the next queued message
3. WHEN skipping a failed message, THEN THE System SHALL NOT block the translation queue
4. WHEN the network is offline, THEN THE System SHALL detect the offline state and pause retry attempts until connectivity is restored

### Requirement 6: Logging and Observability

**User Story:** As a developer, I want detailed logging of translation failures and retries, so that I can diagnose issues and monitor system health.

#### Acceptance Criteria

1. WHEN an Error_Response is detected, THEN THE System SHALL log the error details including the error message
2. WHEN a Retry_Attempt is initiated, THEN THE System SHALL log the retry attempt number and reason
3. WHEN a Valid_Translation is received after retries, THEN THE System SHALL log the number of retries required
4. WHEN a persistent failure occurs, THEN THE System SHALL log a warning with the original text and final error state
