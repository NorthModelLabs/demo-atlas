import { accessGuard } from "@/app/lib/demo-access";
import { NextResponse } from "next/server";
import { voiceTurnDetection } from "@/app/lib/voice-input";
import { tailAccess } from "@/app/lib/tail-access";
export async function POST(req: Request, {params}: {params: Promise<{id: string}>}) {
  const mode=tailAccess(req);if(!mode)return new Response(null,{status:404});
  const {id} = await params;
  const denied = accessGuard(req,"session",id); if (denied) return denied;
  if (!/^ses_[a-f0-9]{20}$/.test(id)) return new Response(null,{status:400});
  const active = await fetch(`${process.env.ATLAS_API_URL}/v1/realtime/session/${id}`, {
    headers:{Authorization:`Bearer ${process.env.ATLAS_API_KEY}`}, cache:"no-store", signal:AbortSignal.timeout(8000)});
  const state = active.ok ? await active.json() : null;
  if (!state || ["ended","failed","error","disconnected"].includes(state.status)) return new Response(null,{status:409});
  if (!process.env.OPENAI_API_KEY) return new Response(null,{status:503});
  if(mode==="hosted"){
    // Exercise the real adapter before opening the voice connection. A health
    // response alone does not prove its first inference is warm.
    try {
      const warm=await fetch(`${process.env.TAIL_ADAPTER_ORIGIN}/adapt`,{
        method:"POST",headers:{"X-Atlas-Tail-Authorization":`Bearer ${process.env.TAIL_ADAPTER_TOKEN}`,"Content-Type":"application/octet-stream"},
        body:new Uint8Array(48000),signal:AbortSignal.timeout(12000),cache:"no-store"});
      const ready=warm.ok?await warm.json():null;
      if(!ready||ready.samples!==24000)throw new Error("Adapter not ready");
    }catch{return NextResponse.json({error:"Audio service is warming up. Please try again."},{status:503});}
  }
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method:"POST", headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    signal:AbortSignal.timeout(20000), body:JSON.stringify({expires_after:{anchor:"created_at",seconds:60},session:{
      type:"realtime",model:"gpt-realtime-2.1",output_modalities:["audio"],reasoning:{effort:"minimal"},
      instructions: "You are Atlas, a friendly voice assistant in an interactive avatar demo. Answer the user's latest request directly, maintaining the conversation's topic. Speak in English by default. Change language only when the user clearly asks you to; do not switch languages because of noise, an accent, or an ambiguous sound. Keep replies to one or two short natural sentences unless the user asks for more. If speech is unclear or incomplete, ask a brief clarification in the current language instead of guessing a request or inventing context. Do not treat background voices, noise, or your own playback as a new user request. Do not claim to see the user's screen or change the demo's settings. Follow requests to say a particular phrase exactly when appropriate.",
      max_output_tokens:2048,
      audio:{input:{format:{type:"audio/pcm",rate:24000},transcription:{model:"gpt-4o-mini-transcribe",language:"en"},
        turn_detection:{...voiceTurnDetection(),interrupt_response:false}},output:{format:{type:"audio/pcm",rate:24000},voice:"coral"}}
    }})});
  if (!response.ok) {
    const failure = await response.json().catch(()=>({}));
    console.error("Staging voice credential request rejected",response.status,String(failure.error?.code||"unknown"),String(failure.error?.param||""));
    return NextResponse.json({error:"Staging voice connection failed"},{status:502});
  }
  const data = await response.json();
  return NextResponse.json({value:data.value,tailTransport:mode==="hosted"?"direct":"proxy"},{headers:{"Cache-Control":"no-store"}});
}
