import { ClientEnrollResponse } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  type DeviceResponse,
  type DeviceTransport,
  enrollWithDeviceInvite,
  exchangeDeviceInvite,
  parseDeviceInvite,
  readDeviceMachines,
} from "./deviceInvite.ts";

const CODE = "0123456789abcdef0123456789abcdef";
const INVITE = { exchangeUrl: "https://kit.example.com/join/device", code: CODE };
const TOKEN = { clientId: "pixel.access", clientSecret: "secret" };

const machine = (id: string, kind: string) => ({
  id,
  name: id.toUpperCase(),
  origin: `https://t3-${id}.example.com`,
  card: `${id}-card`,
  kind,
  level: "use",
});

const ENROLLED = Schema.decodeSync(ClientEnrollResponse)({
  clientId: "pixel.access",
  name: "Pixel",
  serviceToken: TOKEN,
  machines: [machine("vps", "t3.app"), machine("vps", "t3.agents"), machine("nas", "site.compose")],
  machinesUrl: "https://kit.example.com/device/machines",
});

const json = (status: number, body: unknown, finalUrl = "https://kit.example.com/x") =>
  ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    finalUrl,
  }) satisfies DeviceResponse;

const answering =
  (response: DeviceResponse): DeviceTransport =>
  async () =>
    response;

describe("parseDeviceInvite", () => {
  it("takes kitshn's device invite link with a 32 hex code", () => {
    expect(parseDeviceInvite(` https://kit.example.com/join/device#code=${CODE} `)).toEqual(INVITE);
  });

  it.each([
    `http://kit.example.com/join/device#code=${CODE}`,
    `https://kit.example.com/enroll/client#code=${CODE}`,
    "https://kit.example.com/join/device#code=0123",
    `https://kit.example.com/join/device#code=${CODE.toUpperCase()}`,
    "https://kit.example.com/join/device",
    "not a link",
  ])("refuses %s", (text) => {
    expect(parseDeviceInvite(text)).toBeNull();
  });
});

describe("exchangeDeviceInvite", () => {
  it.each([
    [404, "Ask the owner for a new invite"],
    [410, "expired"],
    [423, "The invite stays"],
    [502, "The invite stays"],
  ])("names what %i means", async (status, text) => {
    await expect(
      exchangeDeviceInvite(INVITE, "Pixel", answering(json(status, { error: "x" }))),
    ).rejects.toThrow(text);
  });

  // kitshn may have changed the secret already, so a retry would only get 404.
  it.each(["no answer", "connection lost before the body"])(
    "never sends the code again after a network error: %s",
    async (failure) => {
      let sent = 0;
      const lost: DeviceTransport = async () => {
        sent++;
        throw new Error(failure);
      };
      await expect(exchangeDeviceInvite(INVITE, "Pixel", lost)).rejects.toThrow(
        "ask the owner for a new invite",
      );
      expect(sent).toBe(1);
    },
  );
});

describe("readDeviceMachines", () => {
  it("keeps only the t3.app cards", async () => {
    const list = await readDeviceMachines(
      ENROLLED.machinesUrl,
      TOKEN,
      answering(json(200, { machines: ENROLLED.machines })),
    );
    expect(list).toEqual({
      _tag: "machines",
      machines: [{ id: "vps", name: "VPS", origin: "https://t3-vps.example.com" }],
    });
  });

  it("reads a redirect to the Access login as a refused token", async () => {
    const login = json(200, {}, "https://team.cloudflareaccess.com/cdn-cgi/access/login");
    expect(await readDeviceMachines(ENROLLED.machinesUrl, TOKEN, answering(login))).toEqual({
      _tag: "refused",
    });
  });
});

describe("enrollWithDeviceInvite", () => {
  it("saves the token at the list origin first, and pairs only t3.app machines", async () => {
    const steps: Array<string> = [];
    const result = await enrollWithDeviceInvite(INVITE, {
      exchange: async () => ENROLLED,
      origin: (url) => URL.parse(url)?.origin ?? null,
      saveToken: async (origin) => void steps.push(`save ${origin}`),
      saveClient: () => void steps.push("client"),
      pair: async (paired) => void steps.push(`pair ${paired.id}`),
    });
    expect(steps).toEqual([
      "save https://kit.example.com",
      "client",
      "save https://t3-vps.example.com",
      "pair vps",
    ]);
    expect(result).toEqual({ name: "Pixel", paired: ["VPS"], failed: [] });
  });
});
