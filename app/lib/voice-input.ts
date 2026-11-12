// Demo-only sensitivity trial. Unconfigured deployments retain their existing
// behavior; the preview opts into 0.75. Do not alter Atlas transport or PCM.
export function voiceTurnDetection(
  value = process.env.DEMO_VAD_THRESHOLD,
  interruptionMode = process.env.DEMO_VOICE_INTERRUPTION_MODE,
) {
  const threshold = value?.trim() ? Number(value) : 0.5;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("Invalid demo voice threshold");
  }
  if (interruptionMode && !["automatic", "disabled"].includes(interruptionMode)) {
    throw new Error("Invalid demo voice interruption mode");
  }
  return {
    type: "server_vad" as const,
    threshold,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: true,
    interrupt_response: interruptionMode !== "disabled",
  };
}
