export type AudioTransport = "rtp" | "ordered_pcm_v1";
export const ORDERED_TRANSPORT:AudioTransport = "ordered_pcm_v1";
export const ORDERED_TOPIC = "atlas.ordered-reply.v1";
export const TRANSPORT_RPC = "atlas.audio.transport.v1";
export type SessionTransport = {sessionId:string;transport:AudioTransport};

export function admittedTransport(value:unknown):AudioTransport {
  if(value === undefined || value === "rtp") return "rtp";
  if(value === ORDERED_TRANSPORT) return ORDERED_TRANSPORT;
  throw new Error("Unsupported session audio transport");
}

export function bindSessionTransport(data:Record<string,unknown>):SessionTransport {
  if(typeof data.session_id!=="string" || !/^ses_[a-f0-9]{20}$/.test(data.session_id)) {
    throw new Error("Invalid session transport binding");
  }
  return {sessionId:data.session_id,transport:admittedTransport(data.audio_transport)};
}

export function transportForSession(binding:SessionTransport|null,sessionId:string|null):AudioTransport {
  if(!binding || !sessionId || binding.sessionId!==sessionId) throw new Error("Stale session audio transport");
  return binding.transport;
}

type Agent = {identity:string;isAgent:boolean};
export async function orderedCpuIdentity(agents:Iterable<Agent>,
  request:(identity:string)=>Promise<string>):Promise<string> {
  const eligible=Array.from(agents).filter(p=>p.isAgent && p.identity!=="avatar_worker");
  if(eligible.length!==1) throw new Error("Expected one exact audio transport agent");
  const identity=eligible[0].identity;
  if(await request(identity)!==ORDERED_TRANSPORT) throw new Error("Audio transport was not accepted by the worker");
  return identity;
}
