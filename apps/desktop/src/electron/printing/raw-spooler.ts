import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

export interface RawSpoolResult {
  jobId: number;
  bytesWritten: number;
}

export interface RawSpooler {
  submit(printerName: string, documentName: string, payload: Buffer): Promise<RawSpoolResult>;
}

const RAW_SPOOLER_CSHARP = `using System; using System.Runtime.InteropServices;
public static class NabtaRawLabelSpooler {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool OpenPrinter(string pPrinterName, out IntPtr hPrinter, IntPtr pDefault);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] static extern int StartDocPrinter(IntPtr hPrinter, int level, [In] DOC_INFO_1 di);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError=true)] static extern bool WritePrinter(IntPtr hPrinter, byte[] data, int count, out int written);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  public static string Send(string printer, string document, byte[] payload) {
    IntPtr handle; Check(OpenPrinter(printer, out handle, IntPtr.Zero));
    try {
      var info=new DOC_INFO_1 { pDocName=document, pOutputFile=null, pDataType="RAW" };
      int job=StartDocPrinter(handle,1,info); if(job<=0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try { Check(StartPagePrinter(handle)); try { int written; Check(WritePrinter(handle,payload,payload.Length,out written)); if(written!=payload.Length) throw new InvalidOperationException("Windows spooler accepted only part of the TSPL command."); return job+":"+written; } finally { EndPagePrinter(handle); } } finally { EndDocPrinter(handle); }
    } finally { ClosePrinter(handle); }
  }
}`;

function runPowerShell(script: string, environment: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Windows RAW spooler timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `Windows RAW spooler exited with ${code ?? "an unknown"} error`));
    });
  });
}

/** Sends TSPL bytes unchanged through the Windows RAW print processor. */
export class WindowsRawSpooler implements RawSpooler {
  async submit(printerName: string, documentName: string, payload: Buffer): Promise<RawSpoolResult> {
    if (process.platform !== "win32") throw new Error("RAW label printing is supported on Windows only");
    if (!printerName.trim() || !documentName.trim() || payload.length === 0) throw new Error("Invalid RAW print request");
    const source = Buffer.from(RAW_SPOOLER_CSHARP, "utf8").toString("base64");
    const payloadPath = join(os.tmpdir(), `nabta-tspl-${randomUUID()}.bin`);
    await writeFile(payloadPath, payload, { mode: 0o600 });
    let output: string;
    try {
      const script = "$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:NABTA_RAW_SOURCE)); Add-Type -TypeDefinition $source -ErrorAction Stop; $data=[IO.File]::ReadAllBytes($env:NABTA_RAW_FILE); [NabtaRawLabelSpooler]::Send($env:NABTA_RAW_PRINTER,$env:NABTA_RAW_DOCUMENT,$data)";
      output = await runPowerShell(script, {
        ...process.env,
        NABTA_RAW_SOURCE: source,
        NABTA_RAW_FILE: payloadPath,
        NABTA_RAW_PRINTER: printerName,
        NABTA_RAW_DOCUMENT: documentName,
      });
    } finally {
      await rm(payloadPath, { force: true }).catch(() => undefined);
    }
    const match = /^(\d+):(\d+)$/u.exec(output);
    if (!match) throw new Error("Windows RAW spooler returned an invalid result");
    return { jobId: Number(match[1]), bytesWritten: Number(match[2]) };
  }
}
