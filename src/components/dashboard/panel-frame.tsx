import type { ReactNode } from "react";

export type PanelFrameProps = {
  title: string;
  detail?: string;
  children: ReactNode;
  className: string;
  headingClassName: string;
};

export function PanelFrame({
  title,
  detail,
  children,
  className,
  headingClassName,
}: PanelFrameProps) {
  return (
    <section className={className}>
      <div className={headingClassName}>
        <div>
          <h2>{title}</h2>
          {detail ? <p>{detail}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}
