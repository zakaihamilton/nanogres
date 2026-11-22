const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const BACKUP_TIMELINE_DAYS = 14;

export type TransferFileWriter = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable: () => Promise<TransferFileWriter> }>;
};

export type TransferProgress = {
  label: string;
  transferred: number;
  total: number;
};

export type BackupTransferCallbacks = {
  transferBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  onProgress: (progress: TransferProgress | null) => void;
  onError: (error: string | null) => void;
  onMessage: (message: string | null) => void;
};

export type BackupTimelineEntry = {
  date: string;
  sizeBytes: number;
  count: number;
};

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function responseError(response: Response): Promise<Error> {
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as Record<string, unknown>).error === "string"
    ) {
      return new Error(String((payload as Record<string, unknown>).error));
    }
  } catch {
    // Fall through to the status-based message.
  }
  return new Error(`Transfer failed (${response.status}).`);
}

async function jsonTransferRequest<T extends object>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (!response.ok) throw await responseError(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (typeof payload !== "object" || payload === null) {
    throw new Error("The Nanogres server returned an invalid response.");
  }
  return payload as T;
}

function triggerBufferedDownload(chunks: Uint8Array[], filename: string): void {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const buffer = new ArrayBuffer(size);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function isFilePickerCancelled(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "AbortError"
  );
}

async function chooseDownloadWriter(filename: string): Promise<TransferFileWriter | null> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) return null;
  const handle = await picker({
    suggestedName: filename,
    types: [
      {
        description: "PostgreSQL custom-format dump",
        accept: { "application/octet-stream": [".dump"] },
      },
    ],
  });
  return handle.createWritable();
}

export async function openBackupSaveWriter(
  suggestedName: string,
  onError: (message: string) => void,
): Promise<{ cancelled: boolean; writer: TransferFileWriter | null }> {
  try {
    return { cancelled: false, writer: await chooseDownloadWriter(suggestedName) };
  } catch (cause) {
    if (!isFilePickerCancelled(cause)) {
      onError(cause instanceof Error ? cause.message : "Could not open the save dialog.");
    }
    return { cancelled: true, writer: null };
  }
}

export async function downloadBackupFile(
  backup: { filename: string; sizeBytes: number },
  writer: TransferFileWriter | null,
  onProgress: (progress: TransferProgress | null) => void,
): Promise<void> {
  if (!backup.sizeBytes) throw new Error("The backup file is empty.");
  if (!writer && backup.sizeBytes > MAX_BUFFERED_DOWNLOAD_BYTES) {
    throw new Error(
      "This browser cannot save files larger than 128 MB directly. Use Chrome or Edge for large backups.",
    );
  }

  const bufferedChunks: Uint8Array[] = [];
  let transferred = 0;
  try {
    while (transferred < backup.sizeBytes) {
      const length = Math.min(TRANSFER_CHUNK_BYTES, backup.sizeBytes - transferred);
      const query = new URLSearchParams({
        offset: String(transferred),
        length: String(length),
      });
      const response = await fetch(
        `/api/nanogres/backups/${encodeURIComponent(backup.filename)}?${query.toString()}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw await responseError(response);
      const chunk = new Uint8Array(await response.arrayBuffer());
      if (chunk.byteLength !== length) {
        throw new Error("The backup download ended before the complete file was received.");
      }
      if (writer) await writer.write(chunk);
      else bufferedChunks.push(chunk);
      transferred += chunk.byteLength;
      onProgress({
        label: `Saving ${backup.filename}`,
        transferred,
        total: backup.sizeBytes,
      });
    }

    if (writer) await writer.close();
    else triggerBufferedDownload(bufferedChunks, backup.filename);
  } catch (cause) {
    await writer?.abort?.().catch(() => {});
    throw cause;
  } finally {
    onProgress(null);
  }
}

export async function uploadBackupRestoreFile(
  file: File,
  targetDatabase: string,
  onProgress: (progress: TransferProgress | null) => void,
): Promise<void> {
  let uploadId: string | null = null;
  try {
    const upload = await jsonTransferRequest<{
      uploadId: string;
      chunkSizeBytes: number;
      chunkCount: number;
    }>("/api/nanogres/restore-uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sizeBytes: file.size }),
    });
    if (/^[a-f0-9]{32}$/.test(upload.uploadId)) uploadId = upload.uploadId;
    if (
      !uploadId ||
      upload.chunkSizeBytes < 1 ||
      upload.chunkSizeBytes > TRANSFER_CHUNK_BYTES ||
      upload.chunkCount !== Math.ceil(file.size / upload.chunkSizeBytes)
    ) {
      throw new Error("The upload service returned invalid settings.");
    }

    for (let offset = 0, index = 0; offset < file.size; index += 1) {
      const end = Math.min(offset + upload.chunkSizeBytes, file.size);
      const chunk = file.slice(offset, end);
      const response = await fetch(`/api/nanogres/restore-uploads/${uploadId}/chunks/${index}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
        cache: "no-store",
      });
      if (!response.ok) throw await responseError(response);
      offset = end;
      onProgress({
        label: `Uploading ${file.name}`,
        transferred: offset,
        total: file.size,
      });
    }

    onProgress({
      label: `Restoring into ${targetDatabase}`,
      transferred: file.size,
      total: file.size,
    });
    await jsonTransferRequest(`/api/nanogres/restore-uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database: targetDatabase }),
    });
    uploadId = null;
  } catch (cause) {
    if (uploadId) {
      try {
        await fetch(`/api/nanogres/restore-uploads/${uploadId}`, {
          method: "DELETE",
          cache: "no-store",
        });
      } catch {
        // The system also removes abandoned uploads after 24 hours.
      }
    }
    throw cause;
  } finally {
    onProgress(null);
  }
}

export function buildBackupTimeline(
  rawBackups: ReadonlyArray<{ createdAt: string; sizeBytes: number }> | undefined,
): BackupTimelineEntry[] {
  if (!rawBackups) return [];
  const map = new Map<string, { sizeBytes: number; count: number }>();
  for (const backup of rawBackups) {
    const createdAt = new Date(backup.createdAt);
    if (Number.isNaN(createdAt.getTime())) continue;
    const day = localDateKey(createdAt);
    const existing = map.get(day) || { sizeBytes: 0, count: 0 };
    map.set(day, { sizeBytes: existing.sizeBytes + backup.sizeBytes, count: existing.count + 1 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay = new Date(today);
  firstDay.setDate(firstDay.getDate() - (BACKUP_TIMELINE_DAYS - 1));

  return Array.from({ length: BACKUP_TIMELINE_DAYS }, (_, index) => {
    const day = new Date(firstDay);
    day.setDate(firstDay.getDate() + index);
    const date = localDateKey(day);
    return { date, ...(map.get(date) ?? { sizeBytes: 0, count: 0 }) };
  });
}
