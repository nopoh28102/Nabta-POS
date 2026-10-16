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
  platform: "win32" as const,
}));
