"use client";

import { useCallback, useEffect, useState } from "react";
import type { DatabaseStorage, StorageDisk } from "./storage-capacity";

export type Database = DatabaseStorage & {
  name: string;
  owner: string;
  sizeBytes: number;
  connections: number;
  maxConnections: number;
  encoding: string;
  systemDatabase: boolean;
};

export type Backup = {
  filename: string;
  database: string;
  createdAt: string;
  sizeBytes: number;
};

export type Role = {
  name: string;
  loginName: string;
  database: string | null;
  connectionDatabase: string | null;
  databases: string[];
  superuser: boolean;
  canCreateDatabase: boolean;
  canCreateRole: boolean;
  validUntil: string | null;
  systemRole: boolean;
  migrationRole: boolean;
  assumeRole: string | null;
};

export type ActivityEvent = {
  action: string;
  detail: string;
  actor: string | null;
  createdAt: string;
};

type OffsiteBackupStatus = {
  configured: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastSuccessAgeSeconds?: number | null;
  backupCount: number;
  storedBytes: number;
  lastError: string | null;
  freshness?: "not-configured" | "pending" | "fresh" | "stale" | "error";
};

export type ServerStatus = {
  postgresVersion: string;
  startedAt: string;
  connections: number;
  maxConnections: number;
  disk: StorageDisk;
  backupRetentionDays: number;
  databaseGrowthPercent?: number;
  databaseQuotaReserveBytes?: number;
  databaseQuotaEnforced?: boolean;
  databaseQuotaReason?: string | null;
  databaseQuotaCheckedAt?: string | null;
  offsiteBackup?: OffsiteBackupStatus;
};

type ApiPayload = object;

export async function apiRequest<T extends ApiPayload>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).error === "string"
        ? String((payload as Record<string, unknown>).error)
        : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  if (typeof payload !== "object" || payload === null)
    throw new Error("The Nanogres server returned an invalid response.");
  return payload as T;
}

export function useActionFeedback() {
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  return { actionError, setActionError, message, setMessage };
}

export function useApiData<T extends ApiPayload>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiRequest<T>(path);
      setData(payload);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load server data.");
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const payload = await apiRequest<T>(path);
        if (active) {
          setData(payload);
          setError(null);
        }
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not load server data.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [path]);
  return { data, error, loading, refresh };
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function useDatabases() {
  const query = useApiData<{ databases: Database[]; status?: ServerStatus }>(
    "/api/nanogres/databases",
  );
  const [fallbackStatus, setFallbackStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    if (!query.data || query.data.status || fallbackStatus) return;
    let active = true;
    void apiRequest<{ status?: ServerStatus }>("/api/nanogres/overview")
      .then((payload) => {
        if (active) setFallbackStatus(payload.status ?? null);
      })
      .catch(() => {
        if (active) setFallbackStatus(null);
      });
    return () => {
      active = false;
    };
  }, [fallbackStatus, query.data]);

  return {
    ...query,
    databases: query.data?.databases ?? [],
    status: query.data?.status ?? fallbackStatus,
  };
}
