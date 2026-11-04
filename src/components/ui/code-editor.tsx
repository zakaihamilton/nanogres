"use client";

import { useCallback, useRef, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import styles from "./code-editor.module.css";

const SQL_KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "ON",
  "GROUP",
  "BY",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "AS",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "CREATE",
  "TABLE",
  "INDEX",
  "VIEW",
  "DATABASE",
  "SCHEMA",
  "ROLE",
  "ALTER",
  "DROP",
  "ADD",
  "COLUMN",
  "CONSTRAINT",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "UNIQUE",
  "CHECK",
  "DEFAULT",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "TRANSACTION",
  "READ",
  "ONLY",
  "WRITE",
  "EXPLAIN",
  "ANALYZE",
  "VERBOSE",
  "BUFFERS",
  "VACUUM",
  "FULL",
  "REINDEX",
  "CASCADE",
  "RESTRICT",
  "TRUE",
  "FALSE",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "NOW",
]);

function highlightSql(text: string): ReactNode[] {
  // Simple tokenization regex matching strings, comments, numbers, words, and symbols
  const regex =
    /(--.*$|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*')|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_][a-zA-Z0-9_]*\b)|(\s+|[^\s\w])/gm;
  const elements: ReactNode[] = [];
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    const [full, comment, str, num, word] = match;
    if (comment) {
      elements.push(
        <span key={key++} className={styles.comment}>
          {comment}
        </span>,
      );
    } else if (str) {
      elements.push(
        <span key={key++} className={styles.str}>
          {str}
        </span>,
      );
    } else if (num) {
      elements.push(
        <span key={key++} className={styles.num}>
          {num}
        </span>,
      );
    } else if (word) {
      const upper = word.toUpperCase();
      if (SQL_KEYWORDS.has(upper)) {
        elements.push(
          <span key={key++} className={styles.kw}>
            {word}
          </span>,
        );
      } else {
        elements.push(<span key={key++}>{word}</span>);
      }
    } else {
      elements.push(<span key={key++}>{full}</span>);
    }
  }

  // Preserve trailing newline rendering
  if (text.endsWith("\n")) {
    elements.push(<span key={key++}>{"\n"}</span>);
  }

  return elements;
}

export function CodeEditor({
  value,
  onChange,
  onExecute,
  placeholder = "SELECT * FROM ...",
  readOnly = false,
  minHeight = 180,
}: {
  value: string;
  onChange: (val: string) => void;
  onExecute?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  minHeight?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = value.split("\n").length;

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Cmd+Enter or Ctrl+Enter -> Execute
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        onExecute?.();
        return;
      }

      // Tab -> Insert 2 spaces
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (!textarea) return;

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const nextValue = value.substring(0, start) + "  " + value.substring(end);
        onChange(nextValue);

        requestAnimationFrame(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        });
      }
    },
    [value, onChange, onExecute],
  );

  const handleFormat = () => {
    // Basic formatting: capitalize standard keywords
    const formatted = value.replace(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g, (match) => {
      const upper = match.toUpperCase();
      return SQL_KEYWORDS.has(upper) ? upper : match;
    });
    onChange(formatted);
  };

  const handleClear = () => {
    onChange("");
    textareaRef.current?.focus();
  };

  return (
    <div className={styles.editorContainer}>
      <div className={styles.editorToolbar}>
        <div className={styles.toolbarLeft}>
          <span className={styles.shortcutHint}>⌘ + Enter to execute</span>
        </div>
        <div className={styles.toolbarRight}>
          <button
            className={styles.toolButton}
            onClick={handleFormat}
            title="Format SQL keywords"
            type="button"
          >
            Format
          </button>
          <button
            className={styles.toolButton}
            onClick={handleClear}
            title="Clear editor"
            type="button"
          >
            Clear
          </button>
        </div>
      </div>
      <div className={styles.editorArea} style={{ minHeight }}>
        <div aria-hidden="true" className={styles.lineNumbers}>
          {Array.from({ length: Math.max(1, lines) }, (_, i) => (
            <div key={i + 1}>{i + 1}</div>
          ))}
        </div>
        <div className={styles.textareaWrap}>
          <div aria-hidden="true" className={styles.highlightLayer}>
            {value ? (
              highlightSql(value)
            ) : (
              <span style={{ color: "var(--ink-muted)" }}>{placeholder}</span>
            )}
          </div>
          <textarea
            ref={textareaRef}
            aria-label="SQL query editor"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            className={styles.textarea}
            disabled={readOnly}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            value={value}
          />
        </div>
      </div>
    </div>
  );
}
