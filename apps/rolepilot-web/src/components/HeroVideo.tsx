import { useEffect, useRef } from "react";

declare global {
  interface Window {
    Hls?: {
      new (config?: Record<string, unknown>): {
        loadSource: (src: string) => void;
        attachMedia: (video: HTMLVideoElement) => void;
        on: (event: string, callback: () => void) => void;
        destroy: () => void;
      };
      isSupported: () => boolean;
      Events: { MANIFEST_PARSED: string };
    };
  }
}

type HeroVideoProps = {
  source: string;
  className?: string;
  scale?: number;
  poster?: string;
};

/** Mirrors the Demo's HLS video element. The card owns its overlay and content layers. */
export function HeroVideo({ source, className = "hero-video", scale = 1, poster }: HeroVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !source) return;

    let hls: InstanceType<NonNullable<Window["Hls"]>> | undefined;
    const play = () => void video.play().catch(() => {});
    const Hls = window.Hls;

    if (Hls?.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(source);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, play);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = source;
      video.addEventListener("loadedmetadata", play);
    }

    return () => {
      video.removeEventListener("loadedmetadata", play);
      hls?.destroy();
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [source]);

  return (
    <video
      ref={videoRef}
      className={className}
      muted
      loop
      playsInline
      autoPlay
      preload="auto"
      poster={poster}
      style={scale === 1 ? undefined : { transform: `scale(${scale})` }}
      aria-hidden="true"
    />
  );
}
