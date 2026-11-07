import { contextBridge, ipcRenderer } from "electron";
import type { IpcRequest } from "@nabta/contracts";

contextBridge.exposeInMainWorld("nabta", Object.freeze({
  invoke: (request: IpcRequest): Promise<unknown> => ipcRenderer.invoke("nabta:invoke", request),
  onBarcodeScanned: (callback: (scan: { barcode: string; source: "SERIAL" | "HID" }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, scan: unknown) => {
      if (!scan || typeof scan !== "object") return;
      const candidate = scan as { barcode?: unknown; source?: unknown };
      if (typeof candidate.barcode !== "string" || (candidate.source !== "SERIAL" && candidate.source !== "HID")) return;
      callback({ barcode: candidate.barcode, source: candidate.source });
    };
    ipcRenderer.on("nabta:barcode-scanned", listener);
    return () => ipcRenderer.removeListener("nabta:barcode-scanned", listener);
  },
  onCloudMigrationProgress: (callback: (progress: { phase: string; percent: number; messageAr: string; completedChunks?: number; totalChunks?: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => {
      if (!progress || typeof progress !== "object") return;
      const candidate = progress as { phase?: unknown; percent?: unknown; messageAr?: unknown; completedChunks?: unknown; totalChunks?: unknown };
      if (typeof candidate.phase !== "string" || typeof candidate.percent !== "number" || typeof candidate.messageAr !== "string") return;
      callback({
        phase: candidate.phase,
        percent: Math.min(100, Math.max(0, Math.round(candidate.percent))),
        messageAr: candidate.messageAr,
        ...(typeof candidate.completedChunks === "number" ? { completedChunks: candidate.completedChunks } : {}),
        ...(typeof candidate.totalChunks === "number" ? { totalChunks: candidate.totalChunks } : {}),
      });
    };
    ipcRenderer.on("nabta:cloud-migration-progress", listener);
    return () => ipcRenderer.removeListener("nabta:cloud-migration-progress", listener);
  },
  platform: "win32" as const,
}));
