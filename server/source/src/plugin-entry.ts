import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOrchestratorServer, doctor } from "./orchestrator/server.js";
import { enableOwnedProcesses, stopOwnedProcesses } from "./orchestrator/runtime.js";

enableOwnedProcesses();
if (process.argv.includes("--doctor")) {
  try {
    console.log(JSON.stringify(await doctor(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
} else {
  const { server, close } = createOrchestratorServer();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    close();
    stopOwnedProcesses();
    await server.close().catch(() => {});
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  process.stdin.once("close", () => void shutdown());
  process.on("uncaughtException", (error) => {
    console.error(error.message);
    void shutdown();
    process.exitCode = 1;
  });
  process.on("unhandledRejection", (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    void shutdown();
    process.exitCode = 1;
  });
  await server.connect(new StdioServerTransport());
}
