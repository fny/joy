# Voice

Voice lets you talk to your coding sessions: ask what they are doing, send instructions, hear concise updates, and answer questions and permission requests. Joy supplies session context and executes the same message and permission operations used by the app.

This replacement is still **draft**. Its conversation and transcription integrations are implemented, but live-provider accuracy, device compatibility, speakerphone echo, listening quality and latency must be validated before it is ready to replace the previous voice service.

## Configure Voice

In **Settings → Voice**, configure:

- **Conversation API format:** OpenAI-compatible Chat Completions or Anthropic-compatible Messages.
- **Conversation base URL:** include the API version path, for example `https://api.openai.com/v1` or `https://api.anthropic.com/v1`. Joy appends `/chat/completions` or `/messages`. A compatible gateway or self-hosted endpoint can be used instead.
- **Conversation model and API key:** use a model available at that endpoint with tool calling. The model identifier is editable; Joy does not assume that your account has access to a particular model. Keys can be empty for endpoints that require no authentication. Changing the endpoint or API format clears its key.
- **Transcription base URL, model and API key:** a separate OpenAI-compatible `/audio/transcriptions` service. `whisper-1` is the initial editable model value. Anthropic-style conversation routing does not supply transcription. Enter transcription credentials separately even if you use the same provider for both.
- **Voice:** choose Alba, Marius, Javert, Fantine, Éponine or Azelma for local speech. Legacy Jean/Cosette selections fall back to Alba because those source voices carry noncommercial licenses.

Provider requests originate from the client. Browser endpoints must support CORS for the app's origin, POST, and the relevant headers (`Authorization`, or `x-api-key`, `anthropic-version`, and `anthropic-dangerous-direct-browser-access`). A custom endpoint that works with curl may still need CORS configuration. An HTTPS page cannot generally call a plain HTTP endpoint. Native networking also follows the platform's transport policies. Browser `localhost` refers to the computer running the browser.

The transcription service must accept the device's recording format: WebM or MP4 on web, M4A on Android, and WAV on iOS. Matching the `/audio/transcriptions` request shape alone does not establish audio-format compatibility. For example, [z.ai transcription](https://docs.z.ai/api-reference/audio/audio-transcriptions) documents WAV/MP3 input; it is not a drop-in choice for Joy's current web and Android capture.

OpenAI-style conversation requests use `max_completion_tokens`; compatible endpoints must support that field and function tools. Anthropic-style requests use `max_tokens` and content-block tool results. Requests have a 45-second overall deadline and retry transport failures, HTTP 408/429 and server failures at most twice. Authentication and validation errors require corrected settings. Requests and action responses are not logged with credentials.

## Talk to your sessions

Tap the microphone in a session. The first activation downloads approximately **132–134 MB** of pinned model and selected voice data. Microphone permission is required. Joy then listens for spoken phrases, transcribes them, and asks the configured conversational model how to respond. Pocket TTS generates the spoken reply on the device.

The conversation keeps track of the session you are viewing and receives updates from other sessions too. It summarizes results naturally, reads question options, and can send your selected answer or approve/deny a pending request when instructed. Session context is supplied as background data; it is not spoken verbatim. Approval execution rechecks that the request is still pending. Recent voice history is retained through pause/resume and cleared when voice ends.

**Stays on** listens until ended. **Standby** also allows pausing, waking on session events or speech, and an optional idle timeout. There is no default billing-driven hang-up. The status bar controls pause/retry/end according to the selected mode; × always ends voice. You can cancel startup from the status bar. The microphone and audio stop when the app backgrounds; returning to the foreground resumes a previously active conversation. Changing voice configuration ends the active conversation.

Capture uses a local audio-level detector with sustained-sound and trailing-silence thresholds. It is not a wake-word or speaker-recognition model. Background speech can trigger it. Web capture requests browser echo cancellation. Android pairs a voice-communication recording source with communication-mode playback. A local Expo module gives iOS voice-processing capture and playback through one audio engine. **Native compilation, speakerphone echo and interruption behavior remain release gates on real devices.** Do not assume a unit test or headset test establishes speakerphone compatibility.

Speech is generated in complete short clips before playback to avoid mid-word gaps when synthesis is slower than real time. Longer spoken replies are split at word boundaries instead of being shortened to excerpts. A new utterance cancels an obsolete model response or speech output. An action already sent to a coding session cannot be undone by interrupting its spoken acknowledgment. Conversation requests and tool rounds are bounded; context and complete tool/result turns are retained within memory limits.

## Privacy and storage

Microphone recordings go to the configured transcription endpoint. Transcripts, recent conversational history, coding-session context and tool results go to the configured conversation endpoint. Provider retention and usage depend on that endpoint. Static model downloads contact Hugging Face; **speech synthesis itself** sends no text or generated audio to a speech service.

API keys and preferences use Joy's existing encrypted account-settings sync. Local settings use the app's existing persistence mechanism; this is not a new guarantee of device keychain storage. Keys are entered with a masked field, can be cleared, and are never displayed in full by Voice settings. Temporary recordings and generated audio are removed after use or cancellation.

Downloaded speech assets are verified against pinned sizes and SHA-256 hashes before caching. Interrupted downloads are not committed. Native model files use app storage; web uses Cache Storage when available. Browsers may evict cached data. Stopping or pausing speech releases the model; later synthesis reloads cached assets. Local synthesis does not make transcription, conversation APIs, or Joy's session sync offline.

## Build and validate

The app bundles `onnxruntime-web@1.24.3` and `onnxruntime-react-native@1.24.3`, including pinned Android AAR and iOS pod versions. App postinstall runs `pocket:prepare` to copy installed web runtime files and the worker to `public/pocket`. Run it again after changing the engine or worker:

```sh
cd packages/joy-app
node scripts/prepare-pocket.cjs
```

Native runtime version **23** includes the ONNX runtime and local voice-audio module, and removes the ElevenLabs native stack. Install a newly compiled native app; an OTA update or Expo Go cannot add native modules. Web exports must include the generated `/pocket` assets. No standalone Pocket server is required.

For up to four WASM CPU threads, serve the app with:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The worker falls back to one thread without cross-origin isolation. HTTPS or localhost is required for browser microphone access and model verification. Plain remote HTTP, including `http://agent-01`, is insufficient for voice. See the [Joy development stack](../../dev/stack/README.md) for direct HTTPS on the VM while keeping daemon and relay ports private.

Using installed dependencies and pinned speech assets (filenames and hashes in `sources/realtime/pocket/assets.json`):

```sh
cd packages/joy-app
../../node_modules/.bin/vitest run sources/realtime sources/sync/settings.spec.ts
../../node_modules/.bin/tsc --noEmit
node scripts/test-pocket.mjs /path/to/models /tmp/voice.wav
node scripts/test-pocket-browser.cjs /path/to/models
node scripts/test-voice-browser.cjs /path/to/models
```

The tests cover provider wire contracts, retries, context and tool results, stale requests, startup/stop/background races, recording cleanup and playback cancellation. The browser conversation fixture uses a fake microphone and simulated API responses; it does not establish real transcription accuracy or LLM behavior. Pocket smoke tests use real inference, but do not establish subjective speech quality.

Before merge, exercise the actual Joy UI on web, Android and iOS with configured providers: first-use setup, repeat use, spoken instructions and questions, approvals including already-answered requests, multiple sessions, interruptions, pause/wake, cancellation, app backgrounding, voice changes and provider errors. Measure full utterance-to-response latency, memory and battery use. Native compilation, device playback and speakerphone echo need explicit evidence; JavaScript export alone is insufficient.

See [third-party notices](../../packages/joy-app/sources/realtime/pocket/NOTICE.md) for model, voice and runtime licenses.
