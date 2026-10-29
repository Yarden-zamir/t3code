/** Fork: machine test data: this machine and one other machine with its service token. */
import { MachineId } from "@t3tools/contracts";

export const SELF = MachineId.make("mac");
export const PEER = MachineId.make("vps");
export const PEER_TOKEN = "vps-token.access";
