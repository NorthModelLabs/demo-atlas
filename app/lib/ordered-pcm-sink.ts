export type Writer={write(bytes:Uint8Array):Promise<void>;close():Promise<void>};
export type Terminal={cancelled:boolean;samples:number;packets:number};
type Clock={now():number;sleep(ms:number):Promise<void>};
export class OrderedPcmSink {
  private chain:Promise<void>=Promise.resolve();private terminal:Promise<Terminal>|null=null;
  private closing:Promise<void>|null=null;private sequence=0;private queued=0;private written=0;
  private ending=false;private cancelled=false;private failure:unknown=null;private deadline:number|null=null;
  private cancelWake!:()=>void;private wake=new Promise<void>(resolve=>{this.cancelWake=resolve});
  constructor(private writer:Promise<Writer>,private fatal:(error:unknown)=>void,
    private clock:Clock={now:()=>performance.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
    void writer.catch(error=>this.fail(error));
  }
  private fail(error:unknown){if(this.failure===null){this.failure=error;this.cancelWake();try{this.fatal(error)}catch{}}}
  private packet(kind:number,payload:Uint8Array){const out=new Uint8Array(9+payload.length),view=new DataView(out.buffer);
    view.setUint8(0,kind);view.setUint32(1,this.sequence);view.setUint32(5,payload.length);out.set(payload,9);return out;}
  private closeWriter(){return this.closing??=this.writer.then(writer=>writer.close());}
  append(pcm:Uint8Array,startInMs=0){
    if(this.ending||this.cancelled||this.failure!==null||!pcm.length||pcm.length%2)throw new Error('Invalid ordered PCM append');
    if(!Number.isFinite(startInMs)||startInMs<0||startInMs>120000||this.queued+pcm.length/2>24000*120)throw new Error('Invalid PCM bounds');
    this.queued+=pcm.length/2;const owned=new Uint8Array(pcm),earliest=this.clock.now()+startInMs;
    this.chain=this.chain.then(async()=>{
      if(this.cancelled||this.failure!==null)return;
      const writer=await this.writer;this.deadline=Math.max(this.deadline??earliest,earliest);
      for(let i=0;i<owned.length;i+=1920){
        if(this.cancelled||this.failure!==null)return;
        await Promise.race([this.clock.sleep(Math.max(0,this.deadline-this.clock.now())),this.wake]);
        if(this.cancelled||this.failure!==null)return;
        const chunk=owned.slice(i,i+1920);
        await writer.write(this.packet(1,chunk));
        // Only writes actually accepted by the reliable stream own a prefix.
        this.sequence++;this.written+=chunk.length/2;this.deadline+=chunk.length/48;
      }
    }).catch(error=>this.fail(error));
  }
  private end():Promise<Terminal>{
    this.ending=true;
    return this.terminal??=(async()=>{
      await this.chain;if(this.failure!==null)throw this.failure;
      const writer=await this.writer;if(this.failure!==null)throw this.failure;
      const result={cancelled:this.cancelled,samples:this.written,packets:this.sequence};
      const body=new Uint8Array(8);new DataView(body.buffer).setBigUint64(0,BigInt(this.written));
      await writer.write(this.packet(result.cancelled?3:2,body));this.sequence++;
      await this.closeWriter();return result;
    })().catch(error=>{this.fail(error);throw error;});
  }
  finish(){return this.end();}
  cancel(){this.cancelled=true;this.cancelWake();return this.end();}
  abort(){void this.cancel().catch(()=>{});}
}
