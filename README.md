# Atlas Realtime — Example App

A minimal Next.js example that demonstrates [Atlas Realtime](https://www.northmodellabs.com) avatar sessions using the [`@northmodellabs/atlas-react`](https://www.npmjs.com/package/@northmodellabs/atlas-react) SDK. Sessions are one-to-one. The client supplies the audio; Atlas renders the avatar.

> **New: ElevenLabs STT** — Voice input now uses ElevenLabs Scribe v2 with hardware echo cancellation, eliminating the feedback loop where the avatar talks to itself. [See below →](#voice-input-elevenlabs-stt)

**What this app does:** You bring your own LLM, TTS (e.g. ElevenLabs), and audio pipeline. Atlas provides the GPU compute and WebRTC video — you get a live avatar that lip-syncs to whatever audio you send. A default face auto-loads on startup — just click Connect.

## Quick Start

```bash
npx create-next-app@latest my-app --yes
cd my-app
npm install @northmodellabs/atlas-react livekit-client @elevenlabs/react
```

Create `.env.local`:

```
ATLAS_API_KEY=your_atlas_api_key
ATLAS_API_URL=https://api.atlasv1.com
```

```bash
npm run dev
```

That's it. Open [http://localhost:3000](http://localhost:3000).

---

## Install

```bash
npm install @northmodellabs/atlas-react livekit-client @elevenlabs/react
```

`@northmodellabs/atlas-react` is the React hook, `livekit-client` is the WebRTC transport, and `@elevenlabs/react` provides STT (speech-to-text) with echo cancellation.

## Usage

### 1. Create a session (server-side)

Your API key stays on the server. Create a Next.js API route that proxies session creation:

```typescript
// app/api/session/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const form = await req.formData();

  const res = await fetch(`${process.env.ATLAS_API_URL}/v1/realtime/session`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.ATLAS_API_KEY}` },
    body: form,
  });

  return NextResponse.json(await res.json(), { status: res.status });
}
```

### 2. Use the hook (client-side)

```typescript
// app/demo.tsx
"use client";

import { useAtlasSession } from "@northmodellabs/atlas-react";

export default function Demo() {
  const session = useAtlasSession({
    autoEnableMic: false,  // passthrough — we control audio
    createSession: async (face) => {
      const form = new FormData();
      form.append("face", face);
      const res = await fetch("/api/session", { method: "POST", body: form });
      const data = await res.json();
      return {
        sessionId: data.session_id,
        livekitUrl: data.livekit_url,
        token: data.token,
      };
    },
    deleteSession: async (sessionId) => {
      await fetch(`/api/session/${sessionId}`, { method: "DELETE" });
    },
  });

  return (
    <div>
      <div ref={session.videoRef} style={{ width: 512, height: 512 }} />

      <button onClick={() => session.connect(faceFile)}>
        Connect
      </button>

      <button onClick={() => session.disconnect()}>
        Disconnect
      </button>

      <p>Status: {session.status}</p>
      <p>Latency: {session.latency}ms</p>
    </div>
  );
}
```

### 3. Send audio to the avatar (passthrough mode)

In passthrough mode, you generate TTS audio yourself (ElevenLabs, OpenAI, etc.) and send it to the avatar for lip-sync.

> **Important: Persistent Audio Track Pattern** — Don't use `session.publishAudio()` directly in passthrough mode. It tears down the audio track immediately after playback, which causes the avatar to freeze. Instead, use a **persistent audio track** that stays published for the entire session and feeds silence when idle. This is how the avatar stays animated continuously.

```typescript
import { useEffect, useRef, useCallback } from "react";
import { useAtlasSession } from "@northmodellabs/atlas-react";
import { LocalAudioTrack, Track } from "livekit-client";

// 1. Create the session with autoEnableMic: false
const session = useAtlasSession({
  autoEnableMic: false,
  createSession: async (face) => {
    const form = new FormData();
    form.append("face", face);
    const res = await fetch("/api/session", { method: "POST", body: form });
    const data = await res.json();
    return { sessionId: data.session_id, livekitUrl: data.livekit_url, token: data.token };
  },
  deleteSession: async (id) => {
    await fetch(`/api/session/${id}`, { method: "DELETE" });
  },
});

// 2. Publish a persistent audio track when connected
const audioCtxRef = useRef<AudioContext | null>(null);
const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
const ttsSourceRef = useRef<AudioBufferSourceNode | null>(null);

useEffect(() => {
  if (session.status !== "connected" || !session.room) return;

  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const mediaTrack = dest.stream.getAudioTracks()[0];
  const lkTrack = new LocalAudioTrack(mediaTrack);

  audioCtxRef.current = audioCtx;
  destRef.current = dest;

  session.room.localParticipant.publishTrack(lkTrack, {
    name: "tts-audio",
    source: Track.Source.Unknown,
  });

  return () => {
    ttsSourceRef.current?.stop();
    try { session.room?.localParticipant.unpublishTrack(lkTrack); } catch {}
    lkTrack.stop();
    audioCtx.close().catch(() => {});
    audioCtxRef.current = null;
    destRef.current = null;
  };
}, [session.status, session.room]);

// 3. Play TTS audio through the persistent track
function playTtsAudio(base64Audio: string) {
  const audioCtx = audioCtxRef.current;
  const dest = destRef.current;
  if (!audioCtx || !dest) return;

  ttsSourceRef.current?.stop();

  const binary = atob(base64Audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  audioCtx.decodeAudioData(bytes.buffer.slice(0)).then((audioBuffer) => {
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(dest);
    ttsSourceRef.current = source;
    source.onended = () => {
      source.disconnect();
      ttsSourceRef.current = null;
    };
    source.start();
  });
}

// 4. Use it: get text from LLM first, then fetch TTS audio separately
async function handleUserMessage(text: string) {
  // Step 1: Get LLM text response (fast — shows immediately)
  const chatRes = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const { text: reply } = await chatRes.json();

  // Step 2: Fetch TTS audio in background (avatar speaks when ready)
  if (reply) {
    const ttsRes = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: reply }),
    });
    const { audio } = await ttsRes.json();
    if (audio) playTtsAudio(audio);
  }
}
```

**How it works:**
- A single `MediaStreamDestination` is published to the LiveKit room for the entire session
- When idle, the destination outputs silence → GPU renders idle animation (avatar stays alive)
- When TTS plays, a `BufferSource` connects to the same destination → audio flows through → avatar lip-syncs
- When TTS ends, the `BufferSource` disconnects → back to silence → avatar returns to idle
- No track re-publishing, no mic toggling, no freeze
- LLM text and TTS audio are fetched separately — text appears instantly, audio follows

---

## Voice Input (ElevenLabs STT)

This app uses **ElevenLabs Scribe v2 Realtime** for speech-to-text instead of the browser's Web Speech API.

### The problem with Web Speech API

The browser's built-in speech recognition picks up *everything* the microphone hears — including the avatar's TTS audio playing through your speakers. This creates a feedback loop where the avatar transcribes its own voice and responds to itself endlessly. The Web Speech API doesn't expose its audio pipeline, so there's no way to apply echo cancellation.

### How ElevenLabs STT fixes it

ElevenLabs Scribe connects to the mic via `getUserMedia` with `echoCancellation: true`. The browser's built-in Acoustic Echo Cancellation (AEC) strips the speaker output from the mic signal at the hardware/OS level *before* audio reaches the STT model. The avatar's voice is never transcribed.

```bash
npm install @elevenlabs/react
```

```typescript
import { useScribe, CommitStrategy } from "@elevenlabs/react";

// Use a ref to avoid dependency cycles with useEffect
const scribeRef = useRef(scribe);
scribeRef.current = scribe;

const scribe = useScribe({
  modelId: "scribe_v2_realtime",
  commitStrategy: CommitStrategy.VAD,    // auto-commit on silence
  vadSilenceThresholdSecs: 0.8,
  languageCode: "en",
  onCommittedTranscript: (data) => {
    // Send the transcript to your application’s chat backend.
    if (data.text.trim()) onUserTranscript(data.text.trim());
  },
});

// Connect with echo cancellation enabled
async function startListening() {
  const res = await fetch("/api/scribe-token");
  const { token } = await res.json();
  await scribeRef.current.connect({
    token,
    microphone: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}
```

### Server-side token endpoint

Scribe requires a single-use WebSocket token. Keep your API key on the server:

```typescript
// app/api/scribe-token/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  const res = await fetch(
    "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! },
    },
  );
  const data = await res.json();
  return NextResponse.json({ token: data.token });
}
```

### React dependency gotcha

The `useScribe` hook returns a new object on every render. If you use `scribe` directly in a `useCallback` dependency array, it causes the callback to be recreated every render, which triggers any `useEffect` that depends on it — leading to a rapid connect/disconnect blinking loop. Store the scribe instance in a `useRef` and access it via `scribeRef.current` inside callbacks to keep references stable.

### Requirements

Add `ELEVENLABS_API_KEY` to `.env.local`. The same key is used for both TTS and STT.

---

## Hook API

```typescript
const session = useAtlasSession({
  autoEnableMic: false,
  createSession: async (face, faceUrl) => SessionInfo,
  deleteSession: async (sessionId) => void,
});
```

### Returns

| Property | Type | Description |
|----------|------|-------------|
| `status` | `string` | `"idle"` \| `"connecting"` \| `"connected"` \| `"disconnected"` \| `"error"` |
| `error` | `string \| null` | Error message if status is `"error"` |
| `videoRef` | `RefObject<HTMLDivElement>` | Attach to a `<div>` — avatar video renders inside |
| `connect(face?, faceUrl?)` | `function` | Start a session with a face image or URL |
| `disconnect()` | `function` | End the session |
| `publishAudio(audio)` | `function` | Send TTS audio (base64, Blob, or ArrayBuffer) — **see note below** |
| `setMicEnabled(enabled)` | `function` | Mute / unmute the microphone |
| `setVolume(v)` | `function` | Set playback volume (0–100) |
| `messages` | `array` | Chat message history |
| `muted` | `boolean` | Whether the mic is muted |
| `latency` | `number` | Current round-trip latency in ms |
| `volume` | `number` | Current playback volume level |
| `sessionId` | `string \| null` | Active session ID |
| `room` | `Room \| null` | Underlying LiveKit Room for advanced scenarios |

> **Note on `publishAudio`:** In passthrough mode, prefer the **persistent audio track pattern** (shown above) over calling `publishAudio()` directly. `publishAudio` tears down the track after each call, which can cause the avatar to freeze between messages. The persistent track pattern keeps a single audio track alive for the entire session, feeding silence when idle and TTS audio when speaking.

---

Omit `mode` for passthrough, or send `emotion` when using behavior controls. Both modes use caller-provided audio.

## Full Architecture

```
Browser  →  /api/session (Next.js)  →  /v1/realtime/session (Atlas API)
```

| Route | Method | Purpose |
|-------|--------|---------|
| `/` | — | Main app (host view with full controls) |
| `/api/session` | POST | Create session (forwards face + mode to Atlas) |
| `/api/session/[id]` | GET | Check session status |
| `/api/session/[id]` | PATCH | Swap face mid-session |
| `/api/session/[id]` | DELETE | End session |
| `/api/chat` | POST | Text → LLM → text response (fast, no audio) |
| `/api/tts` | POST | Text → ElevenLabs → base64 audio |
| `/api/scribe-token` | GET | Single-use ElevenLabs Scribe WebSocket token |
| `/api/config` | GET | Check which optional keys are configured |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ATLAS_API_KEY` | Yes | Your Atlas API key (`ak_...`) |
| `ATLAS_API_URL` | Yes | Atlas API base URL (`https://api.atlasv1.com`) |
| `OPENAI_API_KEY` | No | Recommended OpenAI API key — enables AI chat |
| `LLM_API_KEY` | No | Compatibility key for OpenAI-compatible providers such as Helicone |
| `LLM_BASE_URL` | No | LLM endpoint (`https://api.openai.com/v1`) |
| `LLM_MODEL` | No | Model name (`gpt-4o-mini`) |
| `ELEVENLABS_API_KEY` | No | ElevenLabs key — enables TTS voice + STT speech input |
| `ELEVENLABS_VOICE_ID` | No | ElevenLabs voice (`JBFqnCBsd6RMkjVDRZzb`) |

Without the optional keys, the app still runs — avatar connects and lip-syncs — but AI chat and voice input are disabled.

## Stack

- **Next.js 16** (App Router)
- **React 19** + **TypeScript**
- **Tailwind CSS v4**
- **[@northmodellabs/atlas-react](https://www.npmjs.com/package/@northmodellabs/atlas-react)** — React hook for Atlas sessions
- **[livekit-client](https://www.npmjs.com/package/livekit-client)** — WebRTC transport
- **[@elevenlabs/react](https://www.npmjs.com/package/@elevenlabs/react)** — ElevenLabs STT (Scribe v2 Realtime)

## Deploy

Deploy to Vercel (or any Node.js host). Set `ATLAS_API_KEY` and `ATLAS_API_URL` as environment variables. Add `OPENAI_API_KEY` for AI chat and the ElevenLabs variables for speech input/output. `LLM_API_KEY` remains supported for OpenAI-compatible providers.

## License

MIT
