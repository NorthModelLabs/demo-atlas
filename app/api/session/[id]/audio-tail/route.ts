import {accessGuard} from "@/app/lib/demo-access";
export async function POST(req:Request,{params}:{params:Promise<{id:string}>}) {
  if(process.env.DEMO_ORDERED_STAGING!=="true"||process.env.NODE_ENV!=="development"||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.ATLAS_API_URL||"")||
    !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(new URL(req.url).origin))return new Response(null,{status:404});
  const {id}=await params;const denied=accessGuard(req,"session",id);if(denied)return denied;
  if(!/^ses_[a-f0-9]{20}$/.test(id)||req.headers.get("content-type")!=="application/octet-stream")return new Response(null,{status:400});
  const reader=req.body?.getReader();if(!reader)return new Response(null,{status:400});
  const chunks:Uint8Array[]=[];let length=0;
  while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;
    if(length>24000*2*120){await reader.cancel();return new Response(null,{status:413});}chunks.push(value);}
  if(!length||length%2)return new Response(null,{status:400});
  const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
  try {
    const result=await fetch("http://127.0.0.1:18359/adapt",{method:"POST",headers:{Authorization:`Bearer ${process.env.TAIL_ADAPTER_TOKEN}`,"Content-Type":"application/octet-stream"},body,signal:AbortSignal.timeout(15000)});
    if(!result.ok)return new Response(null,{status:502});
    return new Response(await result.text(),{headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
  }catch{return new Response(null,{status:502});}
}
