import { E2E_ENGINE_PORT, E2E_TOKEN } from "../playwright.config";

/**
 * Mark the first-run tour as seen, so it does not cover the screens the specs drive.
 * The tour itself has its own unit tests.
 */
export default async function globalSetup() {
  const ws = new WebSocket(`ws://127.0.0.1:${E2E_ENGINE_PORT}/rpc?token=${E2E_TOKEN}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("engine did not answer settings.set")), 15_000);
    ws.onerror = () => reject(new Error("could not connect to the e2e engine"));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "settings.set",
          params: { key: "ui.onboarded", value: true },
        }),
      );
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; error?: { message: string } };
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve();
    };
  });
}
