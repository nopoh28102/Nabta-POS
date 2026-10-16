import type { IpcRequest } from "@nabta/contracts";

declare global {
  interface Window {
    nabta: {
      invoke(request: IpcRequest): Promise<unknown>;
      onBarcodeScanned(callback: (scan: { barcode: string; source: "SERIAL" | "HID" }) => void): () => void;
      platform: "win32";
    };
  }
}

export {};
