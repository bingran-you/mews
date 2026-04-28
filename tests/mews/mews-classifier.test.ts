/**
 * Exhaustive coverage for `classifyMewsStatus`, mirroring the state
 * machine defined in the status state-machine spec (historical migration doc, now removed; see git history).
 *
 * Every named transition from spec §1 and every precedence rule from
 * spec §2 gets its own assertion so the intent is visible.
 */
import { describe, expect, it } from "vitest";

import { classifyMewsStatus } from "../../src/mews/engine/runtime/classifier.js";

describe("classifier — precedence rules (spec §2)", () => {
  it("rule 1: mews:done wins over everything", () => {
    // mews:done > OPEN state
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: "OPEN" }),
    ).toBe("done");
    // mews:done beats mews:human + mews:wip (fetcher.rs:816-822)
    expect(
      classifyMewsStatus({
        labels: ["mews:done", "mews:human", "mews:wip"],
        ghState: "OPEN",
      }),
    ).toBe("done");
    // mews:done wins over MERGED/CLOSED too (idempotent).
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: "MERGED" }),
    ).toBe("done");
  });

  it("rule 2: MERGED/CLOSED derives done absent mews:done", () => {
    expect(
      classifyMewsStatus({ labels: [], ghState: "MERGED" }),
    ).toBe("done");
    expect(
      classifyMewsStatus({ labels: [], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("rule 2: MERGED/CLOSED wins over mews:human and mews:wip", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "MERGED" }),
    ).toBe("done");
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("rule 3: mews:human wins on OPEN", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("rule 3: mews:human wins over mews:wip on OPEN", () => {
    expect(
      classifyMewsStatus({
        labels: ["mews:human", "mews:wip"],
        ghState: "OPEN",
      }),
    ).toBe("human");
  });

  it("rule 4: mews:wip on OPEN derives wip", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("rule 5: no mews:* labels on OPEN → new", () => {
    expect(classifyMewsStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("rule 5: unrelated labels on OPEN → new", () => {
    expect(
      classifyMewsStatus({
        labels: ["bug", "wontfix", "area:docs"],
        ghState: "OPEN",
      }),
    ).toBe("new");
  });

  it("rule 5: mews:new label alone does NOT override (§2 subtleties)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:new"], ghState: "OPEN" }),
    ).toBe("new");
  });
});

describe("classifier — null / undefined ghState (Discussion et al.)", () => {
  it("null ghState + no mews labels → new", () => {
    expect(classifyMewsStatus({ labels: [], ghState: null })).toBe("new");
    expect(classifyMewsStatus({ labels: [], ghState: undefined })).toBe("new");
  });
  it("null ghState + mews:wip → wip (labels still drive derivation)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: null }),
    ).toBe("wip");
  });
  it("null ghState + mews:human → human", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: null }),
    ).toBe("human");
  });
  it("null ghState + mews:done → done", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: null }),
    ).toBe("done");
  });
});

describe("classifier — observable state-machine transitions (spec §1)", () => {
  // Each transition is expressed as a before/after pair: we classify the
  // "after" state with its label + gh_state snapshot, because the classifier
  // itself is stateless. The comment names the §1 transition.

  it("[*] → new: first-seen notification", () => {
    expect(classifyMewsStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("new → wip: mews:wip label added", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("new → human: mews:human label added", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("new → done (via label): mews:done added, still OPEN", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("new → done (via gh_state): state flips to MERGED/CLOSED", () => {
    expect(classifyMewsStatus({ labels: [], ghState: "MERGED" })).toBe("done");
    expect(classifyMewsStatus({ labels: [], ghState: "CLOSED" })).toBe("done");
  });

  it("wip → human: label swap", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "OPEN" }),
    ).toBe("human");
  });

  it("wip → done (via label swap)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("wip → done (via gh_state MERGED/CLOSED)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: "MERGED" }),
    ).toBe("done");
  });

  it("wip → new: all mews:* labels removed while OPEN", () => {
    expect(classifyMewsStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("human → wip: label swap", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("human → done (label swap)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("human → done (gh_state MERGED/CLOSED)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "CLOSED" }),
    ).toBe("done");
  });

  it("human → new: all labels removed, still OPEN", () => {
    expect(classifyMewsStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("done → new: mews:done removed AND gh_state OPEN (reopen)", () => {
    expect(classifyMewsStatus({ labels: [], ghState: "OPEN" })).toBe("new");
  });

  it("done → wip: reopen with mews:wip", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:wip"], ghState: "OPEN" }),
    ).toBe("wip");
  });

  it("done → human: reopen with mews:human", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "OPEN" }),
    ).toBe("human");
  });
});

describe("classifier — edge cases (spec §9)", () => {
  it("PR reopened after done: labels still drive, stays done (spec §9)", () => {
    // gh_state OPEN but mews:done label still present → done wins.
    expect(
      classifyMewsStatus({ labels: ["mews:done"], ghState: "OPEN" }),
    ).toBe("done");
  });

  it("PR merged while mews:human on it → done (not human)", () => {
    expect(
      classifyMewsStatus({ labels: ["mews:human"], ghState: "MERGED" }),
    ).toBe("done");
  });
});
