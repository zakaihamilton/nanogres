import {
  cloneElement,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import styles from "./tooltip.module.css";

type TooltipTargetProps = {
  "aria-describedby"?: string;
};

export function Tooltip({
  children,
  label,
  placement = "top",
}: {
  children: ReactNode;
  label?: string;
  placement?: "top" | "bottom";
}) {
  const tooltipId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const isOpen = hovered || focused;

  useLayoutEffect(() => {
    if (!isOpen) return;

    const updatePosition = () => {
      const target = wrapperRef.current?.getBoundingClientRect();
      const tooltip = labelRef.current?.getBoundingClientRect();
      if (!target || !tooltip) return;

      const edge = 12;
      const gap = 8;
      const halfWidth = tooltip.width / 2;
      const centerX = target.left + target.width / 2;
      const left = Math.max(
        edge + halfWidth,
        Math.min(centerX, window.innerWidth - edge - halfWidth),
      );
      const preferredTop =
        placement === "bottom" ? target.bottom + gap : target.top - tooltip.height - gap;
      const top = Math.max(
        edge,
        Math.min(preferredTop, window.innerHeight - tooltip.height - edge),
      );

      setPosition({ left, top });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, placement, label]);

  if (!label) return <>{children}</>;

  const target = isValidElement<TooltipTargetProps>(children)
    ? cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], tooltipId]
          .filter(Boolean)
          .join(" "),
      })
    : children;

  return (
    <span
      className={styles.tooltip}
      onBlur={(event: FocusEvent<HTMLSpanElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onFocus={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      ref={wrapperRef}
    >
      {target}
      <span
        className={styles.label}
        id={tooltipId}
        ref={labelRef}
        role="tooltip"
        style={{ left: `${position.left}px`, top: `${position.top}px` }}
      >
        {label}
      </span>
    </span>
  );
}
