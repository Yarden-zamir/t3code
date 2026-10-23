import {
  arrowCapabilities,
  ArrowCapability,
  type ArrowRecord,
} from "@t3tools/contracts/machineMap";

import { CAPABILITY_LABEL, CAPABILITY_TEXT } from "./format.ts";

/** MM-1915: one sticker for each thing that agents on the source can do on the target. */
export function CapabilityStickers({ arrow }: { arrow: ArrowRecord }) {
  return arrowCapabilities(arrow).map((capability) => (
    <span key={capability} className="sticker accent flat" data-tip={CAPABILITY_TEXT[capability]}>
      {CAPABILITY_LABEL[capability]}
    </span>
  ));
}

/** MM-1915: "what can A do on B", every capability with yes or no, for the arrow panel. */
export function CapabilityList({
  arrow,
  from,
  to,
}: {
  arrow: ArrowRecord;
  from: string;
  to: string;
}) {
  const can = new Set(arrowCapabilities(arrow));
  return (
    <>
      <p className="small">
        What agents on {from} can do on {to}:
      </p>
      <ul className="capabilities" aria-label={`What agents on ${from} can do on ${to}`}>
        {ArrowCapability.literals.map((capability) => (
          <li key={capability} className={can.has(capability) ? "yes" : "no"}>
            <span className={`sticker flat ${can.has(capability) ? "ok" : "none"}`}>
              {can.has(capability) ? "yes" : "no"}
            </span>{" "}
            {CAPABILITY_TEXT[capability]}
          </li>
        ))}
        <li className="no">
          <span className="sticker flat none">later</span> Copy secrets and .env files. Not
          available yet.
        </li>
      </ul>
    </>
  );
}
