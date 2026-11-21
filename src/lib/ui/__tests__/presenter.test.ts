import { describe, expect, it } from "vitest";
import { autoplayPauseMs, autoplayTitle, autoplayToggle, canFireNext, presenterKey, type PresenterKey } from "../presenter";

describe("canFireNext", () => {
  const idle = { busy: false, revealIdle: true, hasScenario: true, finished: false };

  it("fires when the reveal is idle and no request is in flight", () => {
    expect(canFireNext(idle)).toBe(true);
  });

  it("does not fire while the reveal of the last event is still playing", () => {
    expect(canFireNext({ ...idle, revealIdle: false })).toBe(false);
  });

  it("does not fire while a request is in flight", () => {
    expect(canFireNext({ ...idle, busy: true })).toBe(false);
  });

  it("does not fire without a scenario or after the last event", () => {
    expect(canFireNext({ ...idle, hasScenario: false })).toBe(false);
    expect(canFireNext({ ...idle, finished: true })).toBe(false);
  });
});

describe("autoplayToggle", () => {
  it("does nothing at the finale, so P never wipes it", () => {
    expect(autoplayToggle({ autoplay: false, hasScenario: true, finished: true })).toBe("ignore");
  });

  it("starts autoplay mid-scenario", () => {
    expect(autoplayToggle({ autoplay: false, hasScenario: true, finished: false })).toBe("start");
  });

  it("stops autoplay when it is on", () => {
    expect(autoplayToggle({ autoplay: true, hasScenario: true, finished: false })).toBe("stop");
    expect(autoplayToggle({ autoplay: true, hasScenario: true, finished: true })).toBe("stop");
  });

  it("starts a scenario when none is active", () => {
    expect(autoplayToggle({ autoplay: false, hasScenario: false, finished: false })).toBe("start-scenario");
  });
});

describe("autoplayTitle", () => {
  it("says the scenario is finished and R restarts it", () => {
    const title = autoplayTitle({ autoplay: false, finished: true });
    expect(title).toMatch(/finished/i);
    expect(title).toMatch(/\bR\b/);
    expect(title).toMatch(/restart/i);
  });

  it("keeps the usual titles otherwise", () => {
    expect(autoplayTitle({ autoplay: false, finished: false })).toBe("Autoplay the remaining events (P)");
    expect(autoplayTitle({ autoplay: true, finished: false })).toBe("Stop autoplay (P)");
  });
});

describe("autoplayPauseMs", () => {
  it("waits at least 3 seconds for a short caption", () => {
    expect(autoplayPauseMs("")).toBe(3000);
    expect(autoplayPauseMs("Risk crosses 80.")).toBe(3000);
  });

  it("reads at about 15 characters per second", () => {
    expect(autoplayPauseMs("x".repeat(90))).toBe(6000);
    expect(autoplayPauseMs("x".repeat(60))).toBe(4000);
    expect(autoplayPauseMs("x".repeat(46))).toBe(3067);
  });

  it("grows with the caption length", () => {
    expect(autoplayPauseMs("x".repeat(120))).toBeGreaterThan(autoplayPauseMs("x".repeat(90)));
  });
});

describe("presenterKey", () => {
  const key = (over: Partial<PresenterKey>): PresenterKey => ({
    key: "",
    code: "",
    repeat: false,
    modified: false,
    typing: false,
    auditOpen: false,
    ...over,
  });

  it("maps the presenter shortcuts", () => {
    expect(presenterKey(key({ key: "ArrowRight", code: "ArrowRight" })).action).toBe("next");
    expect(presenterKey(key({ key: " ", code: "Space" })).action).toBe("next");
    expect(presenterKey(key({ key: "p", code: "KeyP" })).action).toBe("autoplay");
    expect(presenterKey(key({ key: "P", code: "KeyP" })).action).toBe("autoplay");
    expect(presenterKey(key({ key: "r", code: "KeyR" })).action).toBe("restart");
    expect(presenterKey(key({ key: "R", code: "KeyR" })).action).toBe("restart");
  });

  it("ignores repeated keydowns for every shortcut", () => {
    for (const k of [
      { key: "ArrowRight", code: "ArrowRight" },
      { key: " ", code: "Space" },
      { key: "p", code: "KeyP" },
      { key: "R", code: "KeyR" },
    ]) {
      const r = presenterKey(key({ ...k, repeat: true }));
      expect(r.action).toBeNull();
      expect(r.preventDefault).toBe(true);
    }
    expect(presenterKey(key({ key: "Escape", code: "Escape", auditOpen: true, repeat: true })).action).toBeNull();
  });

  it("ignores keys while typing or with Ctrl, Cmd or Alt", () => {
    expect(presenterKey(key({ key: "r", code: "KeyR", typing: true }))).toEqual({ action: null, preventDefault: false });
    expect(presenterKey(key({ key: "r", code: "KeyR", modified: true }))).toEqual({ action: null, preventDefault: false });
  });

  it("only Escape works while the audit overlay is open", () => {
    expect(presenterKey(key({ key: "Escape", code: "Escape", auditOpen: true })).action).toBe("close-audit");
    expect(presenterKey(key({ key: "ArrowRight", code: "ArrowRight", auditOpen: true })).action).toBeNull();
    expect(presenterKey(key({ key: "Escape", code: "Escape" })).action).toBeNull();
  });

  it("leaves other keys alone", () => {
    expect(presenterKey(key({ key: "Tab", code: "Tab" }))).toEqual({ action: null, preventDefault: false });
  });
});
