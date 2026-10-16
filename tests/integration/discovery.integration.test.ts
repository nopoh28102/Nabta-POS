import dgram from "node:dgram";
import { describe, expect, it } from "vitest";
import { startDiscoveryResponder } from "../../apps/server/src/discovery.js";

describe("LAN server discovery", () => {
  it("answers the Nabta discovery request without exposing credentials", async () => {
    const discoveryPort = 48_000 + Math.floor(Math.random() * 500);
    const stop = await startDiscoveryResponder({ apiPort: 7443, discoveryPort, tls: true });
    const socket = dgram.createSocket("udp4");
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("discovery timeout")), 1_000);
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
      socket.once("message", (message) => { clearTimeout(timer); resolve(JSON.parse(message.toString("utf8")) as Record<string, unknown>); });
      socket.bind(0, "127.0.0.1", () => socket.send("NABTA_DISCOVER_V1", discoveryPort, "127.0.0.1"));
    });
    socket.close(); await stop();
    expect(response).toMatchObject({ protocol: "NABTA_DISCOVER_V1", name: "نبتة", apiPort: 7443, tls: true });
    expect(response).not.toHaveProperty("password");
    expect(response).not.toHaveProperty("databaseUrl");
  });
});
