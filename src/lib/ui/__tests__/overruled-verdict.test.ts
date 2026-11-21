import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshStore, runScenario } from "@/lib/__tests__/helpers";
import { whenIdle } from "@/lib/investigations";
import { getSnapshot } from "@/lib/snapshot";
import type { RunInvestigation } from "@/lib/types";
import { fullReveal } from "../reveal";
import { toView } from "../view-model";

const control = vi.hoisted(() => ({ allow: false }));

vi.mock("@/lib/investigator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/investigator")>();
  const runInvestigation: RunInvestigation = async (ctx, tools, sink, options) => {
    const result = await actual.runInvestigation(ctx, tools, sink, options);
    if (!control.allow) return result;
    return { ...result, verdict: { ...result.verdict, assessment: "LIKELY_LEGITIMATE", recommendedAction: "ALLOW" } };
  };
  return { ...actual, getLlmStatus: () => ({ configured: false, model: null }), runInvestigation };
});

beforeEach(async () => {
  await freshStore();
  control.allow = false;
});

async function finalView() {
  runScenario("B");
  await whenIdle();
  const s = getSnapshot();
  return toView(s, {
    reveal: fullReveal(s),
    pending: null,
    autoplay: false,
    reachable: true,
    actionError: null,
    retry: { status: "idle" },
    verifyError: null,
  });
}

describe("verdict overruled by the gateway", () => {
  it("marks an ALLOW verdict as overruled and still shows the takeover finale", async () => {
    control.allow = true;
    const view = await finalView();
    expect(view.investigation.verdict).toMatchObject({
      title: "Likely legitimate",
      action: "Allow and monitor",
      failed: false,
      overruled: true,
      overruledText: "Overruled by the gateway: payment stays on hold, session stays restricted.",
    });
    expect(view.actions.payment.value).toBe("On hold");
    expect(view.actions.session.value).toBe("Restricted");
    expect(view.finale).toMatchObject({ tone: "protected", title: "ACCOUNT TAKEOVER CONTAINED • AED 85,000 PROTECTED (SIMULATION)" });
  });

  it("does not mark a HOLD_AND_RESTRICT verdict as overruled", async () => {
    const view = await finalView();
    expect(view.investigation.verdict).toMatchObject({
      action: "Hold payment + restrict session",
      overruled: false,
      overruledText: null,
    });
    expect(view.finale).toMatchObject({ tone: "protected" });
  });
});
