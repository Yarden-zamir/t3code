import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newThreadStartChoice } from "./forkNewThreadStartChoice";

const mac = EnvironmentId.make("mac");
const vps = EnvironmentId.make("vps");
const project = (environmentId: EnvironmentId, id: string, scratch = false) => ({
  environmentId,
  id,
  scratch,
});
const macScratch = project(mac, "scratch", true);
const vpsScratch = project(vps, "scratch", true);
const macApp = project(mac, "app");
const projects = [macScratch, macApp, vpsScratch];

const choose = (
  input: Partial<Parameters<typeof newThreadStartChoice<(typeof projects)[number]>>[0]>,
) =>
  newThreadStartChoice({
    scratch: true,
    last: null,
    rememberedScratch: { environmentId: mac, projectId: "scratch" },
    projects,
    isScratch: (candidate) => candidate.scratch,
    connected: new Set(),
    canStartScratch: false,
    ...input,
  });

describe("newThreadStartChoice without a project", () => {
  it("keeps the remembered environment while it is connected", () => {
    expect(choose({ connected: new Set([mac, vps]) })).toEqual({
      kind: "project",
      project: macScratch,
    });
  });

  it("prefers a connected environment to the remembered offline one", () => {
    expect(choose({ connected: new Set([vps]) })).toEqual({
      kind: "project",
      project: vpsScratch,
    });
    expect(
      choose({ connected: new Set([vps]), projects: [macScratch], canStartScratch: true }),
    ).toEqual({ kind: "start-scratch" });
  });

  it("opens the remembered project at once when nothing is connected", () => {
    expect(choose({})).toEqual({ kind: "project", project: macScratch });
  });
});

describe("newThreadStartChoice with the last project", () => {
  const last = { environmentId: mac, projectId: "app" };

  it("opens the last project when its environment is connected or nothing is", () => {
    expect(choose({ scratch: false, last, connected: new Set([mac]) })).toEqual({
      kind: "project",
      project: macApp,
    });
    expect(choose({ scratch: false, last })).toEqual({ kind: "project", project: macApp });
  });

  it("keeps the picker when the last project is offline and another environment is connected", () => {
    expect(choose({ scratch: false, last, connected: new Set([vps]) })).toEqual({
      kind: "picker",
    });
  });
});
