import type {OrderedPcmSink} from "./ordered-pcm-sink";
// Retain an explicitly bounded PCM suffix; never alter released speech.
export type TailResult = {samples:number; start_sample:number; tail:string; report:Record<string,unknown>};
export class TailAudioPlayer {
  private key = "";
  private chunks:Uint8Array[]=[];
  private pending=new Uint8Array();
  private samples=0;
  private released=0;
  private ended=false;
  private stopped=false;
  private sources=new Set<AudioBufferSourceNode>();
  private clock:number|null=null;
  private adaptation:AbortController|null=null;
  constructor(private context:AudioContext,private destination:AudioNode,
    private adapt:(pcm:Uint8Array,signal:AbortSignal)=>Promise<TailResult>,
    private probe:(event:string,data:Record<string,unknown>)=>void,
    private drained:()=>void, private tailMs:number=400, private ordered?:OrderedPcmSink) {
    if(tailMs!==400&&tailMs!==600)throw new Error("Unsupported tail window");
  }
  async append(key:string,base64:string) {
    if(this.stopped||this.ended||(this.key&&key!==this.key))throw new Error("Interleaved or ended audio");
    if(typeof base64!=="string"||base64.length>Math.ceil((24000*120-this.samples)*2/3)*4)throw new Error("Invalid or oversized PCM reply");
    this.key=key;
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    if(!bytes.length||bytes.length%2||this.samples+bytes.length/2>24000*120)throw new Error("Invalid or oversized PCM reply");
    this.chunks.push(bytes);this.samples+=bytes.length/2;
    const joined=new Uint8Array(this.pending.length+bytes.length);joined.set(this.pending);joined.set(bytes,this.pending.length);
    const count=Math.max(0,joined.length-this.tailMs*24*2);
    if(count){this.schedule(joined.slice(0,count),false);this.released+=count/2;}
    this.pending=joined.slice(count);
    this.probe("tail_audio_queue",{samples:this.samples,released:this.released,heldSamples:this.pending.length/2,
      queuedMs:Math.max(0,(this.clock??this.context.currentTime)-this.context.currentTime)*1000,scheduledNodes:this.sources.size});
  }
  private schedule(bytes:Uint8Array,final:boolean) {
    if(this.stopped)return;
    if(!bytes.length){if(final)this.drained();return;}
    const buffer=this.context.createBuffer(1,bytes.length/2,24000), floats=buffer.getChannelData(0), view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    for(let i=0;i<floats.length;i++)floats[i]=view.getInt16(i*2,true)/32768;
    const now=this.context.currentTime;
    if(this.clock!==null&&now>this.clock)this.probe("tail_audio_underrun",{seconds:now-this.clock});
    this.clock=Math.max(this.clock??now+.08,now);
    const node=this.context.createBufferSource();node.buffer=buffer;node.connect(this.destination);this.sources.add(node);
    node.onended=()=>{node.disconnect();this.sources.delete(node);if(final&&!this.stopped)this.drained();};
    this.ordered?.append(bytes,Math.max(0,(this.clock-this.context.currentTime)*1000));
    node.start(this.clock);this.clock+=buffer.duration;
  }
  async finish(key:string) {
    if(this.stopped||this.ended||!this.samples||this.key!==key)throw new Error("No matching PCM endpoint");
    this.ended=true;
    const all=new Uint8Array(this.samples*2);let offset=0;for(const chunk of this.chunks){all.set(chunk,offset);offset+=chunk.length;}
    const started=this.context.currentTime;
    const controller=new AbortController();this.adaptation=controller;
    // Never delay the remaining speech while waiting for optional tail cleanup.
    // Schedule the original suffix before playback reaches it if processing is late.
    const budgetMs=Math.max(0,((this.clock??started+.72)-started-.12)*1000);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const expired=new Promise<null>(resolve=>{
        timer=setTimeout(()=>{resolve(null);controller.abort();},budgetMs);
      });
      const result=await Promise.race([this.adapt(all,controller.signal),expired]);
      if(this.stopped)return;
      let tail=this.pending;
      if(result===null){
        this.probe("tail_audio_deadline_fallback",{samples:this.samples,released:this.released,budgetMs,original_suffix_preserved:true});
      }else{
        tail=Uint8Array.from(atob(result.tail),c=>c.charCodeAt(0));
        if(result.samples!==this.samples||result.start_sample!==this.released||tail.length!==this.pending.length)throw new Error("Tail sample ownership mismatch");
        this.probe("tail_audio_applied",{...result.report,samples:this.samples,released:this.released,
          adapterMs:(this.context.currentTime-started)*1000,remainingScheduledMs:Math.max(0,(this.clock??this.context.currentTime)-this.context.currentTime)*1000});
      }
      this.schedule(tail,true);this.pending=new Uint8Array();this.chunks=[];
      await this.ordered?.finish();
    } finally {
      if(timer!==undefined)clearTimeout(timer);
      if(this.adaptation===controller)this.adaptation=null;
    }

  }
  abort(){const cancelled=this.ordered?.cancel();this.stopped=true;this.adaptation?.abort();this.adaptation=null;for(const source of this.sources){source.stop();source.disconnect();}this.sources.clear();this.chunks=[];this.pending=new Uint8Array();return cancelled??Promise.resolve();}
}
