/** Fork: machine test data: this machine and one other machine. */
import { MachineId } from "@t3tools/contracts";

export const SELF = MachineId.make("mac");
export const PEER = MachineId.make("vps");
