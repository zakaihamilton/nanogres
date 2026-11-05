import type { ReactNode } from "react";
import { SectionInfo } from "./section-info";

export type PanelFrameProps = {
  title: string;
  detail?: string;
  info?: string;
  children: ReactNode;
  className: string;
  headingClassName: string;
};

export function PanelFrame({
  title,
  detail,
  info,
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
        {info ? <SectionInfo label={info} /> : null}
      </div>
      {children}
    </section>
  );
}
