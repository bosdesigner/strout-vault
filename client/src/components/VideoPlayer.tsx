import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { VideoOff } from "lucide-react";
import { cn } from "@/lib/utils";

export interface VideoHandle {
  seek(sec: number, play?: boolean): void;
}

interface Props {
  src: string | null;
  mimeType?: string | null;
  audioOnly?: boolean;
  startAt?: number | null;
  onTime: (t: number) => void;
  className?: string;
}

/**
 * Plain <video>: range requests make seeking work against presigned URLs and
 * the local driver alike. Seeks requested before metadata loads are queued.
 */
export const VideoPlayer = forwardRef<VideoHandle, Props>(function VideoPlayer({ src, mimeType, audioOnly, startAt, onTime, className }, ref) {
  const el = useRef<HTMLVideoElement>(null);
  const pending = useRef<{ sec: number; play: boolean } | null>(startAt != null ? { sec: startAt, play: false } : null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const applySeek = (sec: number, play: boolean) => {
    const v = el.current;
    if (!v) return;
    v.currentTime = Math.max(0, sec);
    if (play) void v.play().catch(() => {});
  };

  useImperativeHandle(ref, () => ({
    seek(sec, play = true) {
      const v = el.current;
      if (v && v.readyState >= 1) applySeek(sec, play);
      else pending.current = { sec, play };
    },
  }));

  useEffect(() => {
    const v = el.current;
    if (!v) return;
    const onMeta = () => {
      setReady(true);
      if (pending.current) {
        applySeek(pending.current.sec, pending.current.play);
        pending.current = null;
      }
    };
    const onTimeUpdate = () => onTime(v.currentTime);
    const onError = () => setFailed(true);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("seeked", onTimeUpdate);
    v.addEventListener("error", onError);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTimeUpdate);
      v.removeEventListener("seeked", onTimeUpdate);
      v.removeEventListener("error", onError);
    };
  }, [onTime, src]);

  if (!src || failed) {
    return (
      <div className={cn("flex aspect-video w-full flex-col items-center justify-center rounded-lg border bg-muted/40 text-muted-foreground", className)} data-testid="video-offline">
        <VideoOff className="h-6 w-6" />
        <p className="mt-2 text-sm">{failed ? "Video could not be played" : "Video not online yet"}</p>
      </div>
    );
  }
  return (
    <video
      ref={el}
      src={src}
      controls
      playsInline
      preload="metadata"
      data-testid="video"
      data-ready={ready || undefined}
      className={cn("w-full rounded-lg bg-black", audioOnly ? "h-14" : "aspect-video", className)}
      title={mimeType ?? undefined}
    />
  );
});
