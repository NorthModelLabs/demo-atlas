// Opt-in demo trial. Provider completion alone is not avatar playback completion.
export class VoiceTurnGate {
  blocked = false;
  private generated = false;
  private providerStopped = false;
  private heardReturn = false;
  private quietSince: number | null = null;
  begin() {
    this.blocked = true;
    this.generated = this.providerStopped = this.heardReturn = false;
    this.quietSince = null;
  }
  generationDone() { this.generated = true; }
  outputStarted() { this.providerStopped = false; this.quietSince = null; }
  outputStopped() { this.providerStopped = true; }
  observe(speaking: boolean, now: number) {
    if (!this.blocked) return false;
    if (speaking) { this.heardReturn = true; this.quietSince = null; return false; }
    if (!this.generated || !this.providerStopped || !this.heardReturn) return false;
    this.quietSince ??= now;
    // Acoustic settling window, not a claim of a backend queue-drained signal.
    if (now - this.quietSince < 600) return false;
    this.blocked = false;
    return true;
  }
}
