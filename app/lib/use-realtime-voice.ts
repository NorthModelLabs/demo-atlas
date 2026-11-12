"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceResponseQueue } from "./voice-response";
import { captionEvent, emptyCaptions, type Captions } from "./voice-captions";
import { probeAudio, probeStats, voiceProbe } from "./voice-diagnostics";
import { VoiceTurnGate } from "./voice-turn-gate";

type Output = { context: AudioContext; destination: MediaStreamAudioDestinationNode };
type Options = {
  avatarSpeaking: boolean;
  sessionId: string | null;
  output: () => Promise<Output>;
  user: (text: string) => void;
  assistant: (text: string) => void;
  thinking: (value: boolean) => void;
  error: (text: string) => void;
};
type Connection = {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  mic?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  abort: AbortController;
  ready: boolean;
  turns: VoiceResponseQueue;
  captions: Captions;
  probes: Array<() => void>;
  turnGate: VoiceTurnGate | null;
  micWanted: boolean;
  vad: Record<string, unknown> | null;
  replyId: string;
  doneAt: number | null;
  outputActive: boolean;
};

export function useRealtimeVoice(options: Options) {
  const opts = useRef(options); opts.current = options;
  const current = useRef<Connection | null>(null);
  const [isConnected, setConnected] = useState(false);
  const [isListening, setListening] = useState(false);
  const [captions, setCaptions] = useState(emptyCaptions);
  const stop = useCallback(() => {
    const c = current.current; current.current = null;
    if (c) {
      c.probes.forEach(cleanup => cleanup());
      c.abort.abort(); c.mic?.getTracks().forEach(t => t.stop());
      c.source?.disconnect(); c.channel.close(); c.peer.close();
    }
    setConnected(false); setListening(false); setCaptions(emptyCaptions()); opts.current.thinking(false);
  }, []);
  const start = useCallback(async () => {
    if (current.current || !opts.current.sessionId) return;
    opts.current.error("");
    const id = opts.current.sessionId;
    const peer = new RTCPeerConnection();
    const channel = peer.createDataChannel("oai-events");
    const c: Connection = {peer, channel, abort: new AbortController(), ready: false, turns: new VoiceResponseQueue(event => channel.send(JSON.stringify(event))), captions: emptyCaptions(), probes: [], turnGate: process.env.NEXT_PUBLIC_DEMO_TURN_TAKING === "true" ? new VoiceTurnGate() : null, micWanted: true, vad: null, replyId: "", doneAt: null, outputActive: false};
    current.current = c;
    const alive = () => current.current === c;
    try {
      const output = await opts.current.output();
      if (!alive()) return;
      c.mic = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}});
      if (!alive()) { c.mic.getTracks().forEach(t => t.stop()); return; }
      c.mic.getAudioTracks().forEach(t => peer.addTrack(t, c.mic!));
      const applyMicrophone = () => {
        const enabled = c.micWanted && !c.turnGate?.blocked;
        c.mic?.getAudioTracks().forEach(t => { t.enabled = enabled; });
        setListening(enabled);
      };
      if (c.turnGate) {
        const timer = setInterval(() => {
          if (!alive() || channel.readyState !== "open") return;
          if (c.turnGate!.observe(opts.current.avatarSpeaking, performance.now())) {
            channel.send(JSON.stringify({type: "session.update", session: {type: "realtime", audio: {input: {turn_detection: c.vad}}}}));
            c.doneAt = null;
            applyMicrophone();
            voiceProbe("turn_listening_resumed");
          } else if (c.turnGate!.blocked && c.doneAt !== null && performance.now() - c.doneAt > 30000) {
            stop();
            opts.current.error("Could not confirm the avatar finished. Reconnect the microphone to continue.");
          }
        }, 100);
        c.probes.push(() => clearInterval(timer));
      }
      c.probes.push(probeAudio(output.context, c.mic, "microphone_audio"), probeStats(() => peer.getStats(), "provider_rtc"));
      peer.ontrack = event => {
        if (!alive()) return;
        c.source?.disconnect();
        c.source = output.context.createMediaStreamSource(new MediaStream([event.track]));
        // Send streaming speech to Atlas. Only the avatar's synchronized return
        // track plays locally, so users do not hear two voices.
        c.source.connect(output.destination);
        c.probes.push(probeAudio(output.context, new MediaStream([event.track]), "provider_audio"));
      };
      channel.onmessage = ({data}) => {
        if (!alive()) return;
        let event; try { event = JSON.parse(data); } catch { return; }
        if (["session.created", "session.updated"].includes(event.type)) {
          const vad = event.session?.audio?.input?.turn_detection;
          if (vad && !c.turnGate?.blocked) c.vad = vad;
          if (vad?.type === "server_vad") voiceProbe("voice_input_settings", {
            threshold: vad.threshold,
            prefix_padding_ms: vad.prefix_padding_ms,
            silence_duration_ms: vad.silence_duration_ms,
            interrupt_response: vad.interrupt_response,
          });
        }
        if (["input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped", "response.created", "response.done", "output_audio_buffer.started", "output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(event.type)) voiceProbe(event.type, {status: event.response?.status});
        if (c.turnGate && event.type === "response.created") {
          if (!c.vad) { stop(); opts.current.error("Voice settings are unavailable. Reconnect to continue."); return; }
          c.replyId = event.response?.id || "";
          c.doneAt = null;
          c.outputActive = false;
          c.turnGate.begin();
          applyMicrophone();
          channel.send(JSON.stringify({type: "session.update", session: {type: "realtime", audio: {input: {turn_detection: null}}}}));
          voiceProbe("turn_microphone_held");
        }
        if (event.type === "output_audio_buffer.started") {
          c.outputActive = true;
          c.doneAt = null;
          c.turnGate?.outputStarted();
        }
        if (event.type === "output_audio_buffer.stopped") {
          c.outputActive = false;
          c.doneAt = performance.now();
          c.turnGate?.outputStopped();
        }
        if (c.turnGate && event.type === "response.done" && event.response?.id === c.replyId) {
          c.turnGate.generationDone();
          // Generation may finish long before audio playback. Only start the
          // recovery timeout when output is no longer actively playing.
          if (!c.outputActive) c.doneAt = performance.now();
        }
        if (event.type === "response.created" && event.response?.id) c.turns.created(event.response.id);
        if (event.type === "response.done" && event.response?.id) c.turns.done(event.response.id);
        const superseded = c.turns.ignores(event.response_id || event.response?.id);
        const previous = c.captions;
        c.captions = superseded ? previous : captionEvent(previous, event);
        setCaptions(c.captions);
        if (event.type === "input_audio_buffer.speech_started") {opts.current.thinking(false);}
        if (event.type === "input_audio_buffer.speech_stopped") {opts.current.thinking(true);}
        if (event.type === "conversation.item.input_audio_transcription.completed") {
          if (event.transcript?.trim()) opts.current.user(event.transcript.trim());
        }
        if (event.type === "conversation.item.input_audio_transcription.failed") opts.current.error("Could not transcribe that turn. Please try again.");
        if (event.type === "response.created") opts.current.thinking(true);
        if (!superseded && event.type === "response.output_audio_transcript.delta" && event.response_id === previous.responseId) opts.current.thinking(false);
        if (!superseded && event.type === "response.output_audio_transcript.done" && event.response_id === previous.responseId && event.transcript?.trim()) opts.current.assistant(event.transcript.trim());
        if (event.type === "response.done") {
          opts.current.thinking(c.turns.busy);
          if (!superseded && event.response?.id === previous.responseId && event.response?.status === "failed") opts.current.error("Voice response failed. Please try again.");
        }
        if (event.type === "error") {
          c.turns.failed(event.error?.event_id);
          voiceProbe("provider_error", {code: typeof event.error?.code === "string" && /^[a-z_]{1,80}$/.test(event.error.code) ? event.error.code : "unknown"});
          // A completion may race with a cancellation already sent in flight.
          if (event.error?.code !== "response_cancel_not_active") {opts.current.thinking(false); opts.current.error("Voice request failed. Please try again.");}
        }
      };
      peer.onconnectionstatechange = () => {
        if (alive() && peer.connectionState === "failed") {stop(); opts.current.error("Voice disconnected. Tap the microphone to reconnect.");}
      };
      const opened = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Voice connection timed out")), 30000);
        const finish = (error?: Error) => {clearTimeout(timeout); c.abort.signal.removeEventListener("abort", aborted); if (error) reject(error); else resolve();};
        const aborted = () => finish(new Error("Connection cancelled"));
        c.abort.signal.addEventListener("abort", aborted, {once: true});
        channel.onopen = () => finish();
        channel.onerror = () => finish(new Error("Voice channel failed"));
      });
      // Negotiation can fail before the open promise is awaited.
      void opened.catch(() => {});
      channel.onclose = () => {if (alive()) {stop(); opts.current.error("Voice disconnected. Tap the microphone to reconnect.");}};
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      const response = await fetch(`/api/session/${id}/voice`, {
        method: "POST", headers: {"Content-Type": "application/sdp"}, body: offer.sdp, signal: c.abort.signal,
      });
      if (!response.ok) throw new Error("Voice connection failed. Tap the microphone to retry.");
      const answer = await response.text(); if (!alive()) return;
      await peer.setRemoteDescription({type: "answer", sdp: answer});
      await opened; if (!alive()) return;
      c.ready = true; setConnected(true); applyMicrophone();
    } catch (error) {
      if (!alive()) return;
      stop(); opts.current.error(error instanceof Error ? error.message : "Voice connection failed");
    }
  }, [stop]);
  const toggleMicrophone = useCallback(() => {
    const c = current.current;
    if (!c) { void start(); return; }
    if (!c.ready) return;
    if (c.turnGate?.blocked) { opts.current.error("Atlas is finishing its reply. Listening resumes automatically afterward."); return; }
    const enabled = !c.mic?.getAudioTracks()[0]?.enabled;
    c.micWanted = enabled;
    c.mic?.getAudioTracks().forEach(t => {t.enabled = enabled;}); setListening(enabled);
  }, [start]);
  const sendText = useCallback((text: string) => {
    const c = current.current;
    if (!c?.ready || c.channel.readyState !== "open") {opts.current.error("Voice is connecting. Try again in a moment."); return;}
    if (c.turnGate?.blocked) { opts.current.error("Atlas is finishing its reply. Send your next message afterward."); return; }
    voiceProbe("typed_input");
    opts.current.error("");
    opts.current.thinking(true);
    c.turns.submit(text);
    c.captions = {...emptyCaptions(), user: text}; setCaptions(c.captions);
  }, []);
  useEffect(() => stop, [stop]);
  return {start, stop, toggleMicrophone, sendText, isConnected, isListening, partialTranscript: captions.partial, captions};
}
