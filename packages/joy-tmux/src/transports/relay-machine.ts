// Relay transport (machine scope): registers every machine-scoped catalog op
// as a joy-* RPC on the relay's machine-scoped socket. Session-scoped ops are
// registered per relay session by Session.attachRelay → bindSessionOps.

import { machineOps } from "../operations";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../registry";
import type { RelayClient } from "../relay.ts";

export function registerMachineOps(relayClient: RelayClient, registry: SessionRegistry): void {
  for (const op of machineOps) {
    relayClient.registerRpcHandler(op.rpcName, async (params) => {
      try {
        return await op.handler(registry, (params ?? {}) as Record<string, unknown>, { via: "rpc" });
      } catch (e) {
        // Distinguish "user needs to confirm dir creation" from generic errors
        // so the app can surface a Modal.confirm rather than a flat error toast.
        if (e instanceof DirectoryCreationApprovalRequired) {
          return { requestToApproveDirectoryCreation: true, directory: e.directory };
        }
        return { error: String(e) };
      }
    });
  }
}
