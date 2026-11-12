"use client";
import { useCallback, useEffect, useRef, useState } from "react";

import { captionEvent, emptyCaptions } from "./voice-captions";
import { VoiceTurnGate } from "./voice-turn-gate";
import { voiceProbe } from "./voice-diagnostics";
import { TailAudioPlayer } from "./tail-audio-player";
import type {OrderedPcmSink} from "./ordered-pcm-sink";
type Options={avatarSpeaking:boolean;sessionId:string|null;output:()=>Promise<{context:AudioContext;destination:MediaStreamAudioDestinationNode;orderedSink?:(response:string,fatal:(error:unknown)=>void)=>OrderedPcmSink}>;user:(s:string)=>void;assistant:(s:string)=>void;thinking:(b:boolean)=>void;error:(s:string)=>void;fatal:()=>Promise<void>};
type Connection={socket:WebSocket;mic:MediaStream;context:AudioContext;worklet:AudioWorkletNode;source:MediaStreamAudioSourceNode;audio:TailAudioPlayer|null;audioKey:string;audioDone:boolean;gate:VoiceTurnGate;wanted:boolean;ready:boolean;timer:ReturnType<typeof setInterval>|null;replyId:string;replyStartedAt:number|null;endAt:number|null;vad:Record<string,unknown>|null};
export function useTailRealtimeVoice(options:Options) {
  const opts=useRef(options);opts.current=options;
  const current=useRef<Connection|null>(null);const starting=useRef(false);const generation=useRef(0);
  const adapterRequest=useRef<AbortController|null>(null);
  const stoppedOutput=useRef<Promise<unknown>>(Promise.resolve());
  const [isConnected,setConnected]=useState(false);const [isListening,setListening]=useState(false);
  const [captions,setCaptions]=useState(emptyCaptions);
  const stop=useCallback(()=>{generation.current++;starting.current=false;const c=current.current;current.current=null;
    adapterRequest.current?.abort();adapterRequest.current=null;
    if(c){if(c.timer)clearInterval(c.timer);c.socket.close();c.mic.getTracks().forEach(t=>t.stop());c.worklet.disconnect();c.source.disconnect();void c.context.close();const ending=c.audio?.abort();if(ending){stoppedOutput.current=ending;void ending.catch(()=>{});}}
    setConnected(false);setListening(false);opts.current.thinking(false);setCaptions(emptyCaptions());},[]);
  const start=useCallback(async()=>{
    if(current.current||starting.current||!opts.current.sessionId)return;
    if(!["127.0.0.1","localhost"].includes(location.hostname)&&process.env.NEXT_PUBLIC_DEMO_TAIL_RELEASE!=="true"){opts.current.error("The ending adjustment is not enabled");return;}
    starting.current=true;const epoch=++generation.current;let mic:MediaStream|undefined;let context:AudioContext|undefined;
    const alive=()=>generation.current===epoch;
    try {
      const result=await fetch(`/api/session/${opts.current.sessionId}/tail-voice`,{method:"POST"});
      if(!result.ok)throw new Error("Staging voice is unavailable");const token=await result.json();
      if(!alive())return;
      const output=await opts.current.output();
      if(!alive())return;
      mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(!alive()){mic.getTracks().forEach(t=>t.stop());return;}
      context=new AudioContext({sampleRate:24000});await context.resume();
      if(context.sampleRate!==24000)throw new Error("This browser cannot provide 24 kHz microphone audio");
      await context.audioWorklet.addModule("/ordered-mic-worklet.js");
      if(!alive()){mic.getTracks().forEach(t=>t.stop());await context.close();return;}
      const source=context.createMediaStreamSource(mic);const worklet=new AudioWorkletNode(context,"ordered-mic",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      source.connect(worklet);worklet.connect(context.destination); // worklet emits silence, never sidetone
      const socket=new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",["realtime","openai-insecure-api-key."+token.value]);
      const c:Connection={socket,mic,context,source,worklet,audio:null,audioKey:"",audioDone:false,gate:new VoiceTurnGate(),wanted:true,ready:false,timer:null,replyId:"",replyStartedAt:null,endAt:null,vad:null};
      current.current=c;
      const send=(event:unknown)=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(event));};
      const applyMic=()=>{const enabled=c.ready&&c.wanted&&!c.gate.blocked;c.mic.getAudioTracks().forEach(t=>t.enabled=enabled);worklet.port.postMessage(enabled);setListening(enabled);};
      const fail=(message:string)=>{
        if(!alive())return;
        stop();opts.current.error(message);
        // Local source cancellation cannot retract media already in Atlas.
        // End this demo session instead of reusing it with stale queued media.
        void opts.current.fatal().catch(()=>opts.current.error("Session cleanup failed. End the call before reconnecting."));
      };
      worklet.port.onmessage=({data}:{data:ArrayBuffer})=>{
        if(!alive()||!c.ready||!c.wanted||c.gate.blocked)return;
        if(socket.bufferedAmount>24000*2*3){fail("Voice input is falling behind. Reconnect to continue.");return;}
        const bytes=new Uint8Array(data);let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);
        send({type:"input_audio_buffer.append",audio:btoa(binary)});
      };
      let chain=Promise.resolve();let queuedBytes=0;let state=emptyCaptions();
      const handle=async(event:Record<string,any>)=>{
        if(!alive())return;
        if(event.type==="session.created"||event.type==="session.updated") {
          const vad=event.session?.audio?.input?.turn_detection;
          if(vad&&!c.gate.blocked)c.vad=vad;
          if(!c.ready){c.ready=true;setConnected(true);applyMic();voiceProbe("ordered_voice_ready");}
        }
        if(event.type==="response.output_audio.delta"){
          const key=[event.response_id,event.item_id,event.content_index].join(":");
          if(event.response_id!==c.replyId||c.audioDone)throw new Error("Audio outside active reply");
          if(!c.audio){
            c.audioKey=key;
            c.audio=new TailAudioPlayer(output.context,output.destination,async (pcm,deadlineSignal)=>{
              const controller=new AbortController();adapterRequest.current=controller;
              try {
                const signal=AbortSignal.any([controller.signal,deadlineSignal,AbortSignal.timeout(15000)]);
                let url=`/api/session/${opts.current.sessionId}/audio-tail`;
                const headers:Record<string,string>={"Content-Type":"application/octet-stream"};
                if(token.tailTransport==="direct"){
                  const hash=await crypto.subtle.digest("SHA-256",pcm as unknown as BufferSource);
                  const sha256=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,"0")).join("");
                  const ticketResult=await fetch(`/api/session/${opts.current.sessionId}/audio-tail-ticket`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({bytes:pcm.byteLength,sha256}),signal});
                  if(!ticketResult.ok)throw new Error("Audio authorization rejected");
                  const ticket=await ticketResult.json();const endpoint=new URL(ticket.url);
                  if(endpoint.protocol!=="https:"||endpoint.username||endpoint.password||endpoint.pathname!=="/adapt"||endpoint.search||endpoint.hash)throw new Error("Invalid audio endpoint");
                  url=endpoint.href;headers["X-Atlas-Tail-Authorization"]=`Bearer ${ticket.ticket}`;
                }
                const result=await fetch(url,{method:"POST",headers,body:pcm as unknown as BodyInit,signal});
                if(!result.ok)throw new Error("Tail adaptation rejected");return await result.json();
              } finally {if(adapterRequest.current===controller)adapterRequest.current=null;}
            },voiceProbe,()=>{if(!alive())return;c.gate.outputStopped();c.endAt=performance.now();voiceProbe("tail_audio_source_drained");},Number(process.env.NEXT_PUBLIC_DEMO_TAIL_MS||"600"),output.orderedSink?.(c.replyId,()=>fail("Ordered audio transport failed")));
            c.gate.outputStarted();
          }
          await c.audio.append(key,event.delta);queuedBytes-=event.delta.length;
          voiceProbe("ordered_pcm_forwarded",{encoded_bytes:event.delta.length});
        }
        if(event.type==="response.output_audio.done"){
          if(!c.audio||c.audioDone||event.response_id!==c.replyId||[event.response_id,event.item_id,event.content_index].join(":")!==c.audioKey)throw new Error("Unmatched audio EOF");
          c.audioDone=true;voiceProbe("tail_audio_eof_received");
        }
        if(event.type==="response.done"){
          if(event.response?.id!==c.replyId||event.response?.status!=="completed"||!c.audioDone||!c.audio)throw new Error("Voice reply did not complete with owned audio");
          await c.audio.finish(c.audioKey);
          c.replyStartedAt=null;
          c.gate.generationDone();c.endAt??=performance.now();opts.current.thinking(false);
        }
        state=captionEvent(state,event as Parameters<typeof captionEvent>[1]);setCaptions(state);
        if(event.type==="input_audio_buffer.speech_stopped")opts.current.thinking(true);
        if(event.type==="conversation.item.input_audio_transcription.completed"&&event.transcript?.trim())opts.current.user(event.transcript.trim());
        if(event.type==="response.output_audio_transcript.delta")opts.current.thinking(false);
        if(event.type==="response.output_audio_transcript.done"&&event.transcript?.trim())opts.current.assistant(event.transcript.trim());
        if(event.type==="error"){voiceProbe("ordered_provider_error",{code:String(event.error?.code||"unknown").slice(0,80)});throw new Error("Voice provider rejected the trial request");}
      };
      socket.onmessage=({data})=>{
        if(!alive())return;let event;try{event=JSON.parse(data);}catch{fail("Invalid voice event");return;}
        // Hold immediately; do not wait behind audio writer backpressure.
        if(event.type==="response.created"){
          if(c.gate.blocked){fail("Overlapping voice reply");return;}
          c.audio?.abort();c.audio=null;c.audioKey="";c.audioDone=false;
          c.replyId=event.response?.id||"";c.replyStartedAt=performance.now();c.gate.begin();c.endAt=null;applyMic();
          send({type:"session.update",session:{type:"realtime",audio:{input:{turn_detection:null}}}});opts.current.thinking(true);
        }
        if(event.type==="response.output_audio.delta"){
          queuedBytes+=event.delta?.length||0;
          if(queuedBytes>24000*2*4/3*30){fail("Avatar audio delivery is falling behind");return;}
        }
        chain=chain.then(()=>handle(event)).catch((error)=>{voiceProbe("ordered_handoff_error",{message:error instanceof Error?error.message:"unknown"});fail("Staging audio handoff failed. Reconnect to continue.");});
      };
      socket.onerror=()=>fail("Staging voice connection failed");socket.onclose=()=>fail("Voice disconnected. Reconnect to continue.");
      c.timer=setInterval(()=>{
        if(!alive())return;
        if(!c.ready&&performance.now()-startedAt>30000){fail("Voice connection timed out");return;}
        if(c.replyStartedAt!==null&&performance.now()-c.replyStartedAt>150000){fail("Voice reply completion timed out. Reconnect to continue.");return;}
        if(c.gate.observe(opts.current.avatarSpeaking,performance.now())){
          if(!c.vad){fail("Voice detection settings unavailable");return;}
          send({type:"input_audio_buffer.clear"});send({type:"session.update",session:{type:"realtime",audio:{input:{turn_detection:c.vad}}}});
          c.endAt=null;applyMic();voiceProbe("ordered_turn_listening_resumed");
        }else if(c.gate.blocked&&c.endAt!==null&&performance.now()-c.endAt>120000)fail("Avatar completion could not be confirmed");
      },100);const startedAt=performance.now();
    }catch(error){mic?.getTracks().forEach(t=>t.stop());if(context&&context.state!=="closed")void context.close();if(alive()){stop();opts.current.error(error instanceof Error?error.message:"Staging voice failed");void opts.current.fatal().catch(()=>opts.current.error("Session cleanup failed. End the call before reconnecting."));}}
    finally{if(alive())starting.current=false;}
  },[stop]);
  const toggleMicrophone=useCallback(()=>{const c=current.current;if(!c){void start();return;}c.wanted=!c.wanted;const enabled=c.ready&&c.wanted&&!c.gate.blocked;c.mic.getAudioTracks().forEach(t=>t.enabled=enabled);c.worklet.port.postMessage(enabled);setListening(enabled);},[start]);
  const sendText=useCallback((text:string)=>{const c=current.current;if(!c?.ready||c.gate.blocked){opts.current.error("Wait for Atlas to finish its reply");return;}
    c.socket.send(JSON.stringify({type:"conversation.item.create",item:{type:"message",role:"user",content:[{type:"input_text",text}]}}));
    c.socket.send(JSON.stringify({type:"response.create"}));},[]);
  const waitForStoppedOutput=useCallback(()=>stoppedOutput.current,[]);
  useEffect(()=>stop,[stop]);
  return{start,stop,waitForStoppedOutput,toggleMicrophone,sendText,isConnected,isListening,partialTranscript:captions.partial,captions};
}
