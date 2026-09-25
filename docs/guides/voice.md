# Voice with Pocket TTS

Tap the **speaker** in a session composer to enable spoken updates for that session. Joy reads completed assistant replies, choice questions and pending approval alerts. Stop with the voice bar or its ×. Changing sessions or leaving the app stops speech and discards queued updates.

This draft implements speech output. It removes the ElevenLabs conversation service; it does not yet replace microphone input, speech recognition or spoken commands. **Reply and approve in the app.** Pocket TTS itself only synthesizes speech. Full conversational voice requires separate work and must not be considered replaced by this draft.

## Runs inside the client

The iOS/Android app uses a bundled native ONNX Runtime. The web client uses a bundled WebAssembly runtime in a dedicated worker. Both execute the same Pocket TTS inference locally. No Python installation, Docker container, Pocket server, daemon speech endpoint or API key is needed.

First activation downloads approximately **132–134 MB** of pinned English model and voice data from Hugging Face. A progress indicator appears while loading; × cancels. Native model files are saved in app storage, and browsers use Cache Storage when available. Downloads are checked against pinned sizes and SHA-256 hashes before use. Interrupted downloads are never treated as complete. The browser revalidates cached files; native storage commits only verified downloads.

Later activations reuse cached model files. Native synthesis then works without a network connection. The web client still needs its app/worker files to be available from the app host or the browser HTTP cache; model caching does not make the whole web app offline. Joy’s session synchronization still needs its normal connections. Browsers can evict cached data or deny persistent caching; in that case a subsequent activation downloads it again. Web speech requires HTTPS or localhost for model verification. Plain HTTP on a remote hostname, including `http://agent-01`, does not provide the required browser crypto API.

**Settings → Voice** offers Alba, Marius, Javert, Fantine, Éponine and Azelma. Changing the voice ends active speech. Old Jean/Cosette selections fall back to Alba because those source voices carry noncommercial licenses. Only the chosen voice file is downloaded, from Kyutai’s individual English April 2026 voice states. English synthesis only; there is no voice cloning UI.

Text remains on the device during speech synthesis. Only static model downloads contact Hugging Face; session text and generated speech are never sent to a speech server. Native playback uses a temporary WAV file that is removed after playback or cancellation. Legacy encrypted ElevenLabs settings remain inert for compatibility with other clients.

## Behavior and limits

- Only the selected session speaks. Reasoning and incremental text are not read. Completed replies are shortened to about 400 characters; this is an excerpt, not an AI summary. Code blocks, internal markup and file/image payloads are omitted.
- Pending approvals announce the tool name without its arguments. Approvals answered before playback are discarded. Choice questions include their options; answer in the app.
- Speech is serialized, bounded to eight queued clips and expires after 30 seconds. Stop cancels model loading, retires generation and prevents late audio from playing. Native inference already in progress is allowed to finish its current operation before releasing the engine.
- Models are unloaded when speech stops or the app backgrounds. The next activation reloads cached files; it does not keep hundreds of megabytes resident while speech is disabled.
- Generation is limited to 500 characters and 500 audio frames (about 40 seconds). This draft buffers each short clip before playback. Slow devices may expire a queued clip before it is ready; latency and memory use need real-device validation.

## Building and testing the draft

The app declares `onnxruntime-web@1.24.3` and `onnxruntime-react-native@1.24.3`. The Expo config plugin also pins the Android AAR and iOS C pod to 1.24.3 instead of the vendor’s floating native versions. Use the repository's pinned package manager to install dependencies. The app postinstall runs `pocket:prepare`, which copies the installed web runtime and Joy's worker to `public/pocket` without downloading any executable code. Run `pnpm --filter joy-app pocket:prepare` after editing the shared engine or worker.

Native builds need native dependency linking and a rebuilt app; an OTA update or Expo Go alone cannot add ONNX Runtime. Web export must include the generated `/pocket` directory. Do not deploy an export that omitted this preparation step.

The PR stays **draft** until synthesis and playback are validated in Joy on web, Android and iOS. Automated WASM and Chrome worker smoke tests have passed; native device playback and listening quality still need review. Required checks: first download/progress, repeat use without model network access, cancellation during load/generation/playback, backgrounding, switching sessions, memory release, voice changes, and intelligible output with measured latency. Mock lifecycle tests do not establish device compatibility or speech quality.

See [third-party notices](../../packages/joy-app/sources/realtime/pocket/NOTICE.md) for model, voice and runtime licenses.

With the pinned model files and Alba’s safetensors file downloaded to a local directory (filenames and hashes are in `assets.json`), the reproducible smoke tests are:

```sh
cd packages/joy-app
node scripts/prepare-pocket.cjs
node scripts/test-pocket.mjs /path/to/models /tmp/pocket.wav
node scripts/test-pocket-browser.cjs /path/to/models
```

The browser test uses an installed Chrome (`CHROME_BIN` can override the executable) and a temporary profile. It serves only the test assets on loopback, plays a generated clip, blocks model downloads, and verifies that a new worker can synthesize from its cache. It does not prove native-device behavior or subjective speech quality.
