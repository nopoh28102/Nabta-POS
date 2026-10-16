import dgram from "node:dgram";

export const NABTA_DISCOVERY_PORT = 47620;
const DISCOVERY_REQUEST = "NABTA_DISCOVER_V1";

export interface DiscoveryOptions {
  apiPort: number;
  discoveryPort?: number;
  tls: boolean;
  certificateFingerprint?: string;
}

/**
 * Advertises only the service endpoint. No credentials or database data are
 * sent over UDP; the client still validates HTTPS and the certificate before
 * using the endpoint.
 */
export async function startDiscoveryResponder(options: DiscoveryOptions): Promise<() => Promise<void>> {
  const socket = dgram.createSocket("udp4");
  const response = Buffer.from(JSON.stringify({
    protocol: DISCOVERY_REQUEST,
    name: "نبتة",
    apiPort: options.apiPort,
    tls: options.tls,
    ...(options.certificateFingerprint ? { certificateFingerprint: options.certificateFingerprint } : {}),
  }));
  socket.on("message", (message, remote) => {
    if (message.toString("utf8") !== DISCOVERY_REQUEST) return;
    socket.send(response, remote.port, remote.address);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { socket.off("listening", onListening); reject(error); };
    const onListening = () => { socket.off("error", onError); resolve(); };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.bind(options.discoveryPort ?? NABTA_DISCOVERY_PORT, "0.0.0.0");
  });
  return async () => new Promise<void>((resolve) => {
    socket.close(() => resolve());
  });
}
