import { admittedTransport, type AudioTransport } from "./audio-transport";

export function requestedAudioTransport():AudioTransport {
  return process.env.DEMO_ORDERED_PCM_ENABLED==="true" ? "ordered_pcm_v1" : "rtp";
}

export async function verifyUpstreamTransport(data:Record<string,unknown>,expected:AudioTransport,
  cancel:(sessionId:string)=>Promise<boolean>):Promise<void> {
  let matches=false;
  try { matches=admittedTransport(data.audio_transport)===expected; } catch {}
  if(matches) return;
  // A mismatched successful creation may already own a billable session.
  // Cancel only its exact returned handle; never automatically retry creation.
  const id=data.session_id;
  let cleaned=false;
  if(typeof id==="string" && /^ses_[a-f0-9]{20}$/.test(id)) {
    try { cleaned=await cancel(id); } catch {}
  }
  throw new Error(cleaned ? "Session transport mismatch; session ended. Reconnect after the service is updated."
    : "Session transport mismatch; cleanup could not be confirmed. Do not automatically retry.");
}
