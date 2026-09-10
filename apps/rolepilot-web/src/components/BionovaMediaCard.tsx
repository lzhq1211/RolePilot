import { ReactNode } from "react";
import { HeroVideo } from "./HeroVideo";

interface BionovaMediaCardProps {
  videoSource: string;
  videoScale?: number;
  badgeText?: string;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  minHeight?: number | string;
}

/**
 * BIONOVA 风格流媒体卡片组件
 * 封装了 HLS 视频流背景、渐变暗色遮罩、自适应圆角以及前景内容层级
 */
export function BionovaMediaCard({
  videoSource,
  videoScale = 1,
  badgeText,
  title,
  description,
  children,
  className = "",
  minHeight = "200px",
}: BionovaMediaCardProps) {
  return (
    <div
      className={`bionova-media-card ${className}`}
      style={{
        position: "relative",
        overflow: "hidden",
        backgroundColor: "var(--rp-bg-media)",
        borderRadius: "var(--rp-radius-card)",
        color: "var(--rp-text-on-media)",
        minHeight,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
      }}
    >
      {/* 背景 HLS 流媒体视频 */}
      <HeroVideo source={videoSource} scale={videoScale} />

      {/* 前景内容层级 */}
      <div
        style={{
          position: "relative",
          zIndex: 10,
          height: "100%",
          padding: "var(--rp-space-6)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        {badgeText && (
          <div>
            <span
              style={{
                display: "inline-block",
                backgroundColor: "var(--rp-bg-surface)",
                color: "var(--rp-text-on-light)",
                padding: "4px 12px",
                borderRadius: "var(--rp-radius-full)",
                fontSize: "0.75rem",
                fontWeight: 600,
              }}
            >
              {badgeText}
            </span>
          </div>
        )}

        {children}

        {(title || description) && (
          <div>
            {title && (
              <div style={{ fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.25, marginBottom: "4px" }}>
                {title}
              </div>
            )}
            {description && (
              <div style={{ fontSize: "0.825rem", color: "var(--rp-text-on-media-muted)", lineHeight: 1.4 }}>
                {description}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
