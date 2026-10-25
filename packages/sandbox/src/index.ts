// @archaeo/sandbox: isolated test runs for candidate patches
import { DockerSandbox, type SandboxProvider } from "./docker";

export * from "./exec";
export * from "./detect";
export * from "./patch";
export * from "./results";
export * from "./docker";

/**
 * SANDBOX_PROVIDER=docker (default) runs tests in local containers. "modal" is reserved for Modal
 * Sandboxes and fails clearly until that adapter exists and MODAL_TOKEN_ID/SECRET are set.
 */
export function createSandboxProvider(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
  const provider = env.SANDBOX_PROVIDER || "docker";
  if (provider === "docker") return new DockerSandbox();
  if (provider === "modal") {
    if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) throw new Error("SANDBOX_PROVIDER=modal needs MODAL_TOKEN_ID and MODAL_TOKEN_SECRET");
    throw new Error("The Modal sandbox adapter is not implemented yet; use SANDBOX_PROVIDER=docker");
  }
  throw new Error(`Unknown SANDBOX_PROVIDER "${provider}"`);
}
