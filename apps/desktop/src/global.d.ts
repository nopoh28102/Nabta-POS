import type { IpcRequest } from "@nabta/contracts";

declare global {
  interface Window {
    nabta: {
      invoke(request: IpcRequest): Promise<unknown>;
      onBarcodeScanned(callback: (scan: { barcode: string; source: "SERIAL" | "HID" }) => void): () => void;
      onCloudMigrationProgress(callback: (progress: { phase: string; percent: number; messageAr: string; completedChunks?: number; totalChunks?: number }) => void): () => void;
      platform: "win32";
    };
  }
}

export {};
