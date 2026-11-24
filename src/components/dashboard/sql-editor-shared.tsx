"use client";

import type { ReactNode } from "react";
import { Select } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "./live-shared";
import styles from "./sql-editor-screen.module.css";

type SqlGuardrailsBarProps = {
  readOnly: boolean;
  onReadOnlyChange: (value: boolean) => void;
  defaultLimit: boolean;
  onDefaultLimitChange: (value: boolean) => void;
  timeoutSeconds: number;
  onTimeoutSecondsChange: (value: number) => void;
  timeoutSelectId?: string;
  actionDisabled: boolean;
  runDisabled: boolean;
  runLabel: string;
  onExplain: () => void;
  onExplainAnalyze: () => void;
  onRun: () => void;
};

export function SqlGuardrailsBar({
  readOnly,
  onReadOnlyChange,
  defaultLimit,
  onDefaultLimitChange,
  timeoutSeconds,
  onTimeoutSecondsChange,
  timeoutSelectId,
  actionDisabled,
  runDisabled,
  runLabel,
  onExplain,
  onExplainAnalyze,
  onRun,
}: SqlGuardrailsBarProps) {
  return (
    <div className={styles.guardrailsBar}>
      <div className={styles.guardrailsLeft}>
        <Tooltip label="Executes inside a read-only transaction">
          <label className={styles.guardrailToggle}>
            <input
              checked={readOnly}
              className={styles.guardrailCheckbox}
              onChange={(event) => onReadOnlyChange(event.target.checked)}
              type="checkbox"
            />
            Read-Only Safety
          </label>
        </Tooltip>
        <Tooltip label="Appends LIMIT 100 to unbounded SELECT queries">
          <label className={styles.guardrailToggle}>
            <input
              checked={defaultLimit}
              className={styles.guardrailCheckbox}
              onChange={(event) => onDefaultLimitChange(event.target.checked)}
              type="checkbox"
            />
            Limit 100
          </label>
        </Tooltip>
        <div className={styles.previewTimeout}>
          <label htmlFor={timeoutSelectId}>Timeout:</label>
          <Select
            className={styles.timeoutSelect}
            id={timeoutSelectId}
            onChange={(value) => onTimeoutSecondsChange(Number(value))}
            value={String(timeoutSeconds)}
          >
            <option value="5">5s</option>
            <option value="15">15s</option>
            <option value="30">30s</option>
          </Select>
        </div>
      </div>
      <div className={styles.actionButtons}>
        <Button disabled={actionDisabled} onClick={onExplain} variant="secondary">
          Explain
        </Button>
        <Button disabled={actionDisabled} onClick={onExplainAnalyze} variant="secondary">
          Explain Analyze
        </Button>
        <Button disabled={runDisabled} onClick={onRun} variant="primary">
          {runLabel}
        </Button>
      </div>
    </div>
  );
}

type SqlResultsMetaProps = {
  commandTag: string;
  durationMs: number;
  rowCount: number;
  extra?: ReactNode;
};

export function SqlResultsMeta({ commandTag, durationMs, rowCount, extra }: SqlResultsMetaProps) {
  return (
    <div className={styles.resultsMeta}>
      <span>
        Status: <strong>{commandTag}</strong>
      </span>
      <span>·</span>
      <span>
        Duration: <span className={styles.durationBadge}>{durationMs}ms</span>
      </span>
      <span>·</span>
      <span>
        Rows: <strong>{rowCount}</strong>
      </span>
      {extra}
    </div>
  );
}
