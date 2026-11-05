"use client";
// Earbud I/O for /pay: push-to-talk recording from a chosen mic, playback to a chosen output.

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

export async function listAudioDevices(): Promise<AudioDevices> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return { inputs: all.filter((d) => d.kind === "audioinput"), outputs: all.filter((d) => d.kind === "audiooutput") };
}

/** Ask once so device labels become visible. */
export async function unlockDeviceLabels(): Promise<void> {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export class PushToTalk {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;

  /** Keep the mic open between presses so recording starts instantly on CAPTURE. */
  async open(deviceId: string | null): Promise<void> {
    this.close();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true },
    });
  }

  get isOpen(): boolean {
    return !!this.stream;
  }

  start(): void {
    if (!this.stream) throw new Error("microphone not open");
    if (this.rec && this.rec.state === "recording") return;
    const mimeType = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.startedAt = Date.now();
  }

  get recording(): boolean {
    return this.rec?.state === "recording";
  }

  /** Stop and return the clip (null if nothing was recorded). */
  stop(): Promise<{ blob: Blob; ms: number } | null> {
    const rec = this.rec;
    if (!rec || rec.state !== "recording") return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
        this.chunks = [];
        this.rec = null;
        resolve(blob.size ? { blob, ms: Date.now() - this.startedAt } : null);
      };
      rec.stop();
    });
  }

  close(): void {
    if (this.rec?.state === "recording") this.rec.stop();
    this.rec = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Play base64 audio on the chosen output (earbuds) when the browser supports setSinkId. */
export async function playAudio(base64: string, mime: string, sinkId: string | null): Promise<void> {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const el = new Audio(url);
  const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && withSink.setSinkId) await withSink.setSinkId(sinkId).catch(() => undefined);
  try {
    await el.play();
    await new Promise<void>((res) => {
      el.onended = () => res();
      el.onerror = () => res();
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
