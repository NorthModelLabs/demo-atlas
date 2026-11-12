// Local trial microphone PCM. No recording or disk storage.
class OrderedMic extends AudioWorkletProcessor {
  constructor() { super(); this.enabled=false; this.used=0; this.samples=new Int16Array(2400);
    this.port.onmessage=({data})=>{this.enabled=!!data;this.used=0;}; }
  process(inputs) {
    if (!this.enabled) return true;
    const mono=inputs[0]?.[0]; if (!mono) return true;
    for (let i=0;i<mono.length;i++) {
      this.samples[this.used++]=Math.round(Math.max(-1,Math.min(1,mono[i]))*32767);
      if(this.used===this.samples.length) {this.port.postMessage(this.samples.buffer,[this.samples.buffer]);this.samples=new Int16Array(2400);this.used=0;}
    }
    return true;
  }
}
registerProcessor("ordered-mic",OrderedMic);
