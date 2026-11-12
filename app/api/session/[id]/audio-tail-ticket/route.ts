import {createHmac,randomBytes} from "node:crypto";
import {accessGuard} from "@/app/lib/demo-access";
import {tailAccess} from "@/app/lib/tail-access";

// PCM goes directly to the bounded adapter: a two-minute reply exceeds
// Vercel's function request-size limit. No long-lived secret reaches the browser.
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}) {
  if(tailAccess(req)!=="hosted")return new Response(null,{status:404});
  const {id}=await params;const denied=accessGuard(req,"session",id);if(denied)return denied;
  if(!/^ses_[a-f0-9]{20}$/.test(id)||req.headers.get("content-type")!=="application/json")return new Response(null,{status:400});
  const reader=req.body?.getReader();if(!reader)return new Response(null,{status:400});
  let raw="";const decoder=new TextDecoder();
  for(;;){const {value,done}=await reader.read();if(done)break;if(raw.length+value.length>1024){await reader.cancel();return new Response(null,{status:413});}raw+=decoder.decode(value,{stream:true});}
  let input;try{input=JSON.parse(raw);}catch{return new Response(null,{status:400});}
  if(!input||!Number.isSafeInteger(input.bytes)||input.bytes<2||input.bytes>5760000||input.bytes%2||!/^[a-f0-9]{64}$/.test(input.sha256))return new Response(null,{status:400});
  try {
    const active=await fetch(`${process.env.ATLAS_API_URL}/v1/realtime/session/${id}`,{
      headers:{Authorization:`Bearer ${process.env.ATLAS_API_KEY}`},cache:"no-store",signal:AbortSignal.timeout(8000)});
    const state=active.ok?await active.json():null;
    if(!state||["ended","failed","error","disconnected"].includes(state.status))return new Response(null,{status:409});
    const payload=Buffer.from(JSON.stringify({v:1,bytes:input.bytes,sha256:input.sha256,origin:process.env.DEMO_PUBLIC_ORIGIN,
      exp:Math.floor(Date.now()/1000)+60,nonce:randomBytes(16).toString("hex")})).toString("base64url");
    const signature=createHmac("sha256",process.env.TAIL_ADAPTER_TOKEN!).update(`atlas-tail-v1.${payload}`).digest("base64url");
    return Response.json({url:new URL("/adapt",process.env.TAIL_ADAPTER_ORIGIN).href,ticket:`v1.${payload}.${signature}`},
      {headers:{"Cache-Control":"no-store"}});
  }catch{return new Response(null,{status:502});}
}
