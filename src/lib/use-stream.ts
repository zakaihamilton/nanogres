"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { ServerStatus, ActivityEvent } from "@/components/dashboard/live-shared";

export type TelemetryPayload = {
  type: string;
  status: ServerStatus;
  activity?: ActivityEvent[];
  timestamp: number;
};

export function useTelemetryStream(enabled = true) {
  const [telemetry, setTelemetry] = useState<TelemetryPayload | null>(null);
  const [isLive, setIsLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fallbackPoll = useCallback(async () => {
    try {
      const res = await fetch("/api/nanogres/overview", { cache: "no-store" });
      if (!res.ok) throw new Error("Offline");
      const data = await res.json();
      if (data?.status) {
        setTelemetry({
          type: "telemetry",
          status: data.status,
          activity: data.activity,
          timestamp: Date.now() / 1000,
        });
        setError(null);
      }
    } catch {
      setError("Waiting for connection...");
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let active = true;

    function startStream() {
      try {
        const es = new EventSource("/api/nanogres/stream");
        esRef.current = es;

        es.addEventListener("telemetry", (event) => {
          if (!active) return;
          try {
            const parsed = JSON.parse(event.data);
            setTelemetry(parsed);
            setIsLive(true);
            setError(null);
            if (pollTimerRef.current) {
              clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
          } catch {
            // ignore malformed SSE
          }
        });

        es.onerror = () => {
          if (!active) return;
          setIsLive(false);
          // Keep EventSource open so its built-in retry can restore the stream.
          if (!pollTimerRef.current) {
            void fallbackPoll();
            pollTimerRef.current = setInterval(() => {
              void fallbackPoll();
            }, 6000);
          }
        };
      } catch {
        if (!active) return;
        setIsLive(false);
        if (!pollTimerRef.current) {
          void fallbackPoll();
          pollTimerRef.current = setInterval(() => {
            void fallbackPoll();
          }, 6000);
        }
      }
    }

    startStream();

    return () => {
      active = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [enabled, fallbackPoll]);

  return { telemetry, isLive, error };
}
