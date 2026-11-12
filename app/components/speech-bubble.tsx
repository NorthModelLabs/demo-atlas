"use client";

import { useEffect, useState } from "react";

/** Presentation only: keep captions out of layout and expire after speech. */
export function SpeechBubble({ text, speaker, active, turn }: {
  text: string;
  speaker: "You" | "Atlas";
  active: boolean;
  turn: string;
}) {
  const content = text.replace(/\s+/g, " ").trim();
  const identity = `${turn}:${content}`;
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!content || active) return;
    const timer = window.setTimeout(() => setExpired(identity), 5000);
    return () => window.clearTimeout(timer);
  }, [content, identity, active]);

  if (!content) return null;
  // Show the newest words of a streamed response rather than an expanding log.
  const tail = content.length > 160 ? content.slice(-160) : content;
  const display = content.length > 160 ? `…${tail.slice(Math.max(0, tail.indexOf(" ") + 1))}` : tail;
  const visible = active || expired !== identity;
  return (
    <div className={`apple-speech-bubble ${speaker === "You" ? "is-user" : "is-atlas"} ${visible ? "is-visible" : "is-expired"}`}
      aria-hidden={!visible}>
      <strong>{speaker}</strong>
      <p><span>{display}</span></p>
    </div>
  );
}
