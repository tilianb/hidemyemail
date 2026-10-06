import { createGateway } from "./gateway.mjs";

const gateway = await createGateway(process.env);
await new Promise((resolve, reject) => {
  gateway.server.once("error", reject);
  gateway.server.listen(gateway.port, gateway.host, resolve);
});
gateway.queue.start();
console.log("[gateway] Public SMTP listening; encrypted queue active");
const status = setInterval(async () => {
  try { console.log("[gateway] Queue status", await gateway.queue.status()); }
  catch { console.error("[gateway] Queue status unavailable; inspect storage and encryption key"); }
}, 60000);
const stop = async () => {
  clearInterval(status);
  await new Promise(resolve => gateway.server.close(resolve));
  await gateway.queue.stop();
  gateway.closeTransport();
};
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
