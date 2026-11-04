"use client";

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

// 3. Compact Quota Ring
export function QuotaRing({
  ratio,
  size = 28,
  strokeWidth = 3.5,
}: {
  ratio: number;
  size?: number;
  strokeWidth?: number;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const offset = circumference - circumference * clampedRatio;
  const percent = Math.round(clampedRatio * 100);

  let color = "var(--green)";
  if (clampedRatio >= 0.9) color = "var(--red)";
  else if (clampedRatio >= 0.75) color = "var(--amber)";

  return (
    <div className={styles.ringWrap}>
      <svg className={styles.ringSvg} height={size} width={size}>
        <circle
          className={styles.ringTrack}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <circle
          className={styles.ringProgress}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={color}
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={offset}
          strokeWidth={strokeWidth}
        />
      </svg>
      <span className={styles.ringPercent} style={{ color }}>
        {percent}%
      </span>
    </div>
  );
}

// 4. Sparkline Trend
export function Sparkline({
  points,
  width = 120,
  height = 36,
  color = "var(--green)",
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points, min + 1);
  const range = max - min;

  const coords = points.map((val, idx) => {
    const x = (idx / (points.length - 1)) * (width - 4) + 2;
    const y = height - 4 - ((val - min) / range) * (height - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M ${coords.join(" L ")}`;
  const areaD = `${pathD} L ${width - 2},${height} L 2,${height} Z`;

  return (
    <svg className={styles.sparklineSvg} height={height} width={width}>
      <path className={styles.sparklineArea} d={areaD} fill={color} />
      <path className={styles.sparklineLine} d={pathD} stroke={color} />
    </svg>
  );
}

// 5. Daily Backup Bar Timeline
export function BackupTimelineChart({
  backups,
  height = 54,
}: {
  backups: Array<{ date: string; sizeBytes: number; count: number }>;
  height?: number;
}) {
  if (!backups.length) return null;
  const maxBytes = Math.max(...backups.map((b) => b.sizeBytes), 1024 * 1024);

  return (
    <div className={styles.timelineWrap}>
      <svg
        className={styles.timelineSvg}
        height={height}
        preserveAspectRatio="none"
        viewBox="0 0 100 50"
      >
        {backups.map((item, idx) => {
          const barWidth = 85 / Math.max(backups.length, 7);
          const x = 5 + idx * (90 / Math.max(backups.length, 7));
          const barHeight = Math.max(4, (item.sizeBytes / maxBytes) * 44);
          const y = 48 - barHeight;

          return (
            <g key={item.date}>
              <title>{`${item.date}: ${(item.sizeBytes / 1024 ** 2).toFixed(1)} MB (${item.count} backups)`}</title>
              <rect
                className={styles.timelineBar}
                fill="var(--green)"
                height={barHeight}
                width={barWidth}
                x={x}
                y={y}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
