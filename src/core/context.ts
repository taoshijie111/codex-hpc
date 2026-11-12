import type { StateStore } from "../state.js";
import type { ServerSpec } from "./types.js";

/** Host-independent services injected into the SSH and job engines. */
export interface CoreContext {
  store: StateStore;
  secret(name: string): string | undefined;
  pinHost(server: ServerSpec, fingerprint: string): Promise<void>;
}
