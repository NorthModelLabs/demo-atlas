// Release is opt-in on both client and server. Local trials retain their
// isolated API constraint; production requires a separately hosted HTTPS adapter.
export function tailAccess(req:Request): "local"|"hosted"|null {
  const origin=new URL(req.url).origin;
  if(process.env.NODE_ENV==="development"&&process.env.DEMO_ORDERED_STAGING==="true"&&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.ATLAS_API_URL||"")&&
    /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))return "local";
  // Next/proxies can canonicalize req.url to an internal hostname. Match the
  // browser Origin against our configured public origin; accessGuard separately
  // requires a signed capability belonging to this exact Atlas session.
  if(process.env.DEMO_TAIL_RELEASE!=="true"||!process.env.DEMO_PUBLIC_ORIGIN||
    req.headers.get("origin")!==process.env.DEMO_PUBLIC_ORIGIN)return null;
  try {
    const service=new URL(process.env.TAIL_ADAPTER_ORIGIN||"");
    if(service.protocol!=="https:"||service.username||service.password||service.pathname!=="/"||service.search||service.hash)return null;
    return (process.env.TAIL_ADAPTER_TOKEN||"").length>=32?"hosted":null;
  }catch{return null;}
}
