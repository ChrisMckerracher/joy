# Voice with Pocket TTS

Tap the **speaker** in an empty session composer to enable spoken updates for that session. Joy reads completed assistant replies, choice questions and pending approval alerts. Stop with the voice bar or its ×. Navigating to another session or leaving the app stops speech, cancels pending work and discards queued updates. A failure shows its cause; tap the bar to retry.

Pocket TTS is a speech synthesizer, not a conversational agent. This replaces the ElevenLabs conversation: Joy no longer records your microphone, interprets spoken commands or answers approvals by voice. **Reply and approve in the app.** There is no automatic speech-recognition or LLM fallback. No ElevenLabs account, agent, key or subscription is required.

## Set up the session machine

Pocket TTS must be installed separately on each machine whose sessions you want to hear. Joy does not install Python packages, download models, or launch the service. Consult [Kyutai’s installation instructions](https://github.com/kyutai-labs/pocket-tts) before installing it. First use may download model/voice weights and must finish before testing Joy.

With Pocket TTS installed, run:

```sh
pocket-tts serve --host 127.0.0.1 --port 8000
```

Set this in the **Joy daemon’s environment**, then restart that daemon:

```sh
JOY_POCKET_TTS_URL=http://127.0.0.1:8000
```

For a managed daemon, set the variable in its service configuration; exporting it in an unrelated shell does not update an already running service. Update both the app and daemon to this version. Older daemons do not have the speech endpoint.

Keep Pocket TTS bound to loopback. The browser/phone sends requests through Joy’s existing authenticated, end-to-end encrypted machine tunnel. There is no need to open port 8000, configure CORS, or point the browser at localhost. The service lives on the session’s machine, which may differ from the device running the app.

**Settings → Voice** selects one of the eight built-in voices. Changing the voice ends active speech; tap the speaker again to use the new voice. A short spoken confirmation tests the complete path. New Pocket TTS UI text currently falls back to English in other app languages. Use the default English model with these voices; language selection and voice cloning are not exposed by this integration.

## Behavior and limits

- Only the explicitly selected session speaks. Incremental text and reasoning are not read aloud. Completed replies are shortened to about 400 characters; this is an excerpt, not an AI summary. Code blocks, embedded file/image payloads and internal markup are omitted.
- Pending approvals announce the tool name, never its arguments. An approval answered before its audio starts is discarded. Choice questions are read with their options; answer in the app.
- Speech is serialized, bounded to eight queued clips and expires after 30 seconds. Repeated pending completion updates replace older ones. Stop aborts transport and prevents late audio from playing.
- The daemon permits one generation at a time, caps text at 500 characters and audio at 4 MiB, and times out generation after 45 seconds. It accepts only built-in voice names and a daemon-configured literal loopback HTTP destination, with redirects disabled.
- The official `/tts` API returns streamed WAV. Joy buffers each short clip and repairs the placeholder WAV lengths before native/web playback. This first integration does **not** play audio as it streams; latency includes generating the clip.
- Speech text and generated audio pass through the encrypted tunnel. Text is processed by the local Pocket TTS process. Native playback uses a temporary cache file, deleted after playback or cancellation. Old encrypted ElevenLabs settings remain inert for compatibility with other clients; this version never reads or sends those credentials.

If the bar shows **Speech unavailable**, check that Pocket TTS is running on the session machine, its model has finished loading, the daemon inherited `JOY_POCKET_TTS_URL`, and the daemon is current. A busy CPU or another device generating speech can also require a retry. On the web, tap the speaker directly to allow browser audio playback.
