"use client";

import { useId, useRef, useState } from "react";
import styles from "./svg-charts.module.css";

// 1. Connection Gauge (240-degree arc)
export function ConnectionGauge({
  current,
  max,
  size = 120,
}: {
  current: number;
  max: number;
  size?: number;
}) {
  const radius = size * 0.38;
  const strokeWidth = size * 0.08;
  const center = size / 2;

  // Arc angles (240 degrees total: from 150deg to 390deg)
  const startAngle = 150;
  const totalAngle = 240;

  const ratio = Math.min(1, Math.max(0, max > 0 ? current / max : 0));
  const circumference = 2 * Math.PI * radius;
  const arcLength = (circumference * totalAngle) / 360;
  const offset = arcLength - arcLength * ratio;

  // Tone color based on usage percentage
  let toneColor = "var(--green)";
  if (ratio > 0.85) {
    toneColor = "var(--red)";
  } else if (ratio > 0.6) {
    toneColor = "var(--amber)";
  }

  // Calculate arc path
  const polarToCartesian = (cx: number, cy: number, r: number, angleInDegrees: number) => {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: cx + r * Math.cos(angleInRadians),
      y: cy + r * Math.sin(angleInRadians),
    };
  };

  const describeArc = (x: number, y: number, r: number, start: number, end: number) => {
    const startPoint = polarToCartesian(x, y, r, end);
    const endPoint = polarToCartesian(x, y, r, start);
    const largeArcFlag = end - start <= 180 ? "0" : "1";
    return [
      "M",
      startPoint.x,
      startPoint.y,
      "A",
      r,
      r,
      0,
      largeArcFlag,
      0,
      endPoint.x,
      endPoint.y,
    ].join(" ");
  };

  const trackPath = describeArc(center, center, radius, startAngle, startAngle + totalAngle);

  return (
    <div className={styles.gaugeWrap} style={{ width: size, height: size * 0.88 }}>
      <svg className={styles.gaugeSvg} height={size} width={size} viewBox={`0 0 ${size} ${size}`}>
        <path className={styles.gaugeTrack} d={trackPath} strokeWidth={strokeWidth} />
        <path
          className={styles.gaugeValue}
          d={trackPath}
          stroke={toneColor}
          strokeDasharray={`${arcLength} ${arcLength}`}
          strokeDashoffset={offset}
          strokeWidth={strokeWidth}
        />
      </svg>
      <div className={styles.gaugeCenter}>
        <div className={styles.gaugeNumber}>{current}</div>
        <div className={styles.gaugeMax}>/ {max} max</div>
      </div>
    </div>
  );
}

// 2. Storage Donut Chart
export type StorageDonutItem = {
  label: string;
  bytes: number;
  color: string;
};

export function StorageDonut({
  items,
  totalBytes,
  size = 110,
}: {
  items: StorageDonutItem[];
  totalBytes: number;
  size?: number;
}) {
  const radius = size * 0.36;
  const strokeWidth = size * 0.16;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  const segments = items.map((item, idx) => {
    const itemRatio = totalBytes > 0 ? item.bytes / totalBytes : 0;
    const prevRatioSum = items
      .slice(0, idx)
      .reduce((sum, prev) => sum + (totalBytes > 0 ? prev.bytes / totalBytes : 0), 0);
    return {
      ...item,
      strokeDasharray: `${circumference * itemRatio} ${circumference * (1 - itemRatio)}`,
      strokeDashoffset: -circumference * prevRatioSum,
    };
  });

  const formatSize = (bytes: number): string => {
    const gib = 1024 ** 3;
    const mib = 1024 ** 2;
    if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GB`;
    return `${(bytes / mib).toFixed(0)} MB`;
  };

  return (
    <div className={styles.donutWrap}>
      <svg className={styles.donutSvg} height={size} width={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={center}
          cy={center}
          fill="none"
          r={radius}
          stroke="var(--surface-muted)"
          strokeWidth={strokeWidth}
        />
        {segments.map((seg) => (
          <circle
            key={seg.label}
            className={styles.donutSegment}
            cx={center}
            cy={center}
            r={radius}
            stroke={seg.color}
            strokeDasharray={seg.strokeDasharray}
            strokeDashoffset={seg.strokeDashoffset}
            strokeWidth={strokeWidth}
          />
        ))}
      </svg>
      <div className={styles.donutLegend}>
        {items.map((item) => (
          <div key={item.label} className={styles.legendItem}>
            <div className={styles.legendLabelWrap}>
              <span className={styles.legendDot} style={{ background: item.color }} />
              <span className={styles.legendLabel}>{item.label}</span>
            </div>
            <span className={styles.legendValue}>{formatSize(item.bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 3. Daily Backup Bar Timeline
function formatTimelineSize(bytes: number): string {
  const safeBytes = Math.max(0, bytes);
  if (safeBytes < 1024) return `${Math.round(safeBytes)} B`;
  if (safeBytes < 1024 ** 2) {
    const kilobytes = safeBytes / 1024;
    return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`;
  }
  if (safeBytes < 1024 ** 3) {
    const megabytes = safeBytes / 1024 ** 2;
    return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
  }
  const gigabytes = safeBytes / 1024 ** 3;
  return `${gigabytes.toFixed(gigabytes < 10 ? 1 : 0)} GB`;
}

function niceTimelineMaximum(value: number): number {
  const safeValue = Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(safeValue));
  const normalized = safeValue / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function formatTimelineDate(dateKey: string, long = false): string {
  const date = new Date(`${dateKey}T12:00:00`);
  return new Intl.DateTimeFormat(
    undefined,
    long
      ? { weekday: "long", month: "long", day: "numeric", year: "numeric" }
      : { month: "short", day: "numeric" },
  ).format(date);
}

export function BackupTimelineChart({
  backups,
  height = 82,
}: {
  backups: Array<{ date: string; sizeBytes: number; count: number }>;
  height?: number;
}) {
  const tooltipId = useId();
  const [activeTooltip, setActiveTooltip] = useState<{ index: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  if (!backups.length) return null;

  const hasBackups = backups.some((backup) => backup.count > 0);
  const largestSize = Math.max(...backups.map((backup) => backup.sizeBytes), 0);
  const scaleMaximum = niceTimelineMaximum(largestSize || 1024);

  const showTooltip = (index: number, target: HTMLButtonElement) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const wrapperBounds = wrapper.getBoundingClientRect();
    const dayBounds = target.getBoundingClientRect();
    const edgeInset = Math.min(132, Math.max(8, (wrapperBounds.width - 16) / 2));
    const dayCenter = dayBounds.left + dayBounds.width / 2 - wrapperBounds.left;
    const left = Math.max(edgeInset, Math.min(wrapperBounds.width - edgeInset, dayCenter));
    setActiveTooltip({ index, left });
  };

  const hideTooltip = (index: number, target: HTMLButtonElement) => {
    if (document.activeElement === target) return;
    setActiveTooltip((current) => (current?.index === index ? null : current));
  };

  return (
    <div className={styles.timelineWrap} ref={wrapperRef}>
      <div className={styles.timelineChart}>
        <div aria-hidden="true" className={styles.timelineYAxis} style={{ height }}>
          <span>{hasBackups ? formatTimelineSize(scaleMaximum) : "—"}</span>
          <span>{hasBackups ? formatTimelineSize(scaleMaximum / 2) : "—"}</span>
          <span>0 B</span>
        </div>
        <div className={styles.timelinePlot} style={{ height }}>
          <div aria-hidden="true" className={styles.timelineGridlines}>
            <span />
            <span />
            <span />
          </div>
          <div className={styles.timelineDays}>
            {backups.map((item, index) => {
              const hasBackup = item.count > 0;
              const barHeight = hasBackup
                ? Math.max(5, (Math.max(0, item.sizeBytes) / scaleMaximum) * 100)
                : 0;
              const description =
                item.count === 0
                  ? `${formatTimelineDate(item.date, true)}: no backups`
                  : `${formatTimelineDate(item.date, true)}: ${formatTimelineSize(item.sizeBytes)} total, ${item.count} backups`;

              return (
                <button
                  aria-describedby={
                    activeTooltip?.index === index ? `${tooltipId}-${index}` : undefined
                  }
                  aria-label={description}
                  className={styles.timelineDay}
                  key={item.date}
                  onBlur={(event) => hideTooltip(index, event.currentTarget)}
                  onClick={(event) => showTooltip(index, event.currentTarget)}
                  onFocus={(event) => showTooltip(index, event.currentTarget)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setActiveTooltip(null);
                  }}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") showTooltip(index, event.currentTarget);
                  }}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== "touch") hideTooltip(index, event.currentTarget);
                  }}
                  type="button"
                >
                  {hasBackup ? (
                    <span
                      aria-hidden="true"
                      className={styles.timelineBar}
                      style={{ height: `${barHeight}%` }}
                    />
                  ) : (
                    <span aria-hidden="true" className={styles.timelineZeroMarker} />
                  )}
                </button>
              );
            })}
          </div>
          {!hasBackups ? (
            <p className={styles.timelineEmptyMessage}>No backups in the last 14 days</p>
          ) : null}
        </div>
        <div aria-hidden="true" className={styles.timelineXAxis}>
          {backups.map((item, index) => {
            const endpoint = index === 0 || index === backups.length - 1;
            const mobileTick = endpoint || index % 6 === 0;
            const showLabel = endpoint || index % 3 === 0;
            if (!showLabel) return null;

            return (
              <span
                className={[
                  styles.timelineAxisLabel,
                  endpoint ? styles.timelineAxisEndpoint : "",
                  mobileTick ? styles.timelineAxisMobileTick : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={item.date}
                style={{ gridColumn: index + 1 }}
              >
                {formatTimelineDate(item.date)}
              </span>
            );
          })}
        </div>
      </div>
      {activeTooltip && backups[activeTooltip.index] ? (
        <div
          className={styles.timelineTooltip}
          id={`${tooltipId}-${activeTooltip.index}`}
          role="tooltip"
          style={{ left: activeTooltip.left }}
        >
          <strong>{formatTimelineDate(backups[activeTooltip.index].date, true)}</strong>
          <span>
            {backups[activeTooltip.index].count === 0
              ? "No backups"
              : `${formatTimelineSize(backups[activeTooltip.index].sizeBytes)} total · ${backups[activeTooltip.index].count} backups`}
          </span>
        </div>
      ) : null}
    </div>
  );
}
