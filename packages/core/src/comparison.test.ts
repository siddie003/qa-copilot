import { describe, expect, it } from "vitest";
import {
  compareScans,
  pageKey,
  type ComparisonFindingInput,
  type ComparisonIssueInput,
  type ComparisonPageInput,
  type ComparisonScanInput,
  type ComparisonStepInput,
  type ComparisonTrackInput,
  type IssueComparisonItem,
} from "./comparison";

const SITE = "https://shop.example";

const page = (path: string, over: Partial<ComparisonPageInput> = {}): ComparisonPageInput => ({
  url: `${SITE}${path}`,
  finalUrl: null,
  httpStatus: 200,
  contentType: "text/html; charset=utf-8",
  crawlError: null,
  captures: [
    { viewport: "desktop", error: null },
    { viewport: "mobile", error: null },
  ],
  ...over,
});

const step = (
  stepKey: string,
  status = "completed",
  over: Partial<ComparisonStepInput> = {},
): ComparisonStepInput => ({
  stepKey,
  status,
  statusReason: null,
  error: null,
  findingCount: 0,
  checks: { evaluated: 1, inconclusive: [], inconclusiveTotal: 0 },
  ...over,
});

let seq = 0;
type FindingSpec = Partial<ComparisonFindingInput> & { path?: string | null };
const finding = ({ path = "/about", ...over }: FindingSpec = {}): ComparisonFindingInput => {
  seq += 1;
  const f: ComparisonFindingInput = {
    id: `f${seq}`,
    displayId: `X-${String(seq).padStart(3, "0")}`,
    scanner: "seo",
    ruleId: "title-missing",
    title: "Page has no title",
    severity: "medium",
    verdict: "confirmed",
    selector: null,
    viewport: null,
    expected: null,
    actual: null,
    fingerprint: "",
    pageUrl: path === null ? null : `${SITE}${path}`,
    ...over,
  };
  f.fingerprint ||= [f.scanner, f.ruleId, path ?? "site", f.selector ?? "", f.viewport ?? ""].join(
    "|",
  );
  return f;
};

const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 } as const;

const issue = (
  displayNo: number,
  findings: ComparisonFindingInput[],
  over: Partial<ComparisonIssueInput> = {},
): ComparisonIssueInput => ({
  id: `i${++seq}`,
  trackId: `t${displayNo}`,
  displayNo,
  category: findings[0]!.scanner,
  ruleId: findings[0]!.ruleId,
  title: findings[0]!.title,
  severity: [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity])[0]!.severity,
  verdict: findings.some((f) => f.verdict === "confirmed")
    ? "confirmed"
    : findings.some((f) => f.verdict === "potential")
      ? "potential"
      : "inconclusive",
  confidence: 0.9,
  affectedUrls: [...new Set(findings.map((f) => f.pageUrl).filter((u): u is string => !!u))],
  findingIds: findings.map((f) => f.id),
  ...over,
});

const SCANNERS = ["accessibility", "seo", "links", "responsive"];

function scan(
  number: number,
  groups: Array<[number, ComparisonFindingInput[], Partial<ComparisonIssueInput>?]>,
  over: Partial<ComparisonScanInput> = {},
): ComparisonScanInput {
  const findings = groups.flatMap(([, f]) => f);
  return {
    id: `scan-${number}`,
    projectId: "p1",
    number,
    status: "completed",
    createdAt: new Date(2026, 9, number),
    startedAt: new Date(2026, 9, number),
    finishedAt: new Date(2026, 9, number, 1),
    websiteUrl: `${SITE}/`,
    scanners: SCANNERS,
    viewports: ["desktop", "mobile"],
    maxPages: 25,
    maxDepth: 3,
    designSpecId: null,
    designSpecVersion: null,
    contentSnapshotHash: null,
    steps: ["preflight", "crawl", "capture", ...SCANNERS, "ai", "grounding"].map((k) =>
      step(k, k === "ai" ? "skipped" : "completed"),
    ),
    pages: [page("/"), page("/about"), page("/contact")],
    findings,
    issues: groups.map(([no, f, o]) => issue(no, f, o)),
    ...over,
  };
}

const track = (
  displayNo: number,
  over: Partial<ComparisonTrackInput> = {},
): ComparisonTrackInput => ({
  trackId: `t${displayNo}`,
  displayNo,
  status: "open",
  lastSeenBeforeBase: null,
  reopenedByTarget: null,
  ...over,
});

const byNo = (items: IssueComparisonItem[], no: number) => items.find((i) => i.displayNo === no)!;
const withSteps = (s: ComparisonScanInput, ...changes: ComparisonStepInput[]) => ({
  ...s,
  steps: s.steps.map((x) => changes.find((c) => c.stepKey === x.stepKey) ?? x),
});

describe("compareScans: classification", () => {
  it("classifies new, resolved, persistent and changed issues and counts them", () => {
    const fp = (o: FindingSpec) => finding(o);
    const title = fp({});
    const desc = fp({ ruleId: "meta-description-missing", path: "/contact" });
    const contrast1 = fp({ scanner: "accessibility", ruleId: "color-contrast", selector: "p.a" });
    const base = scan(1, [
      [1, [title]],
      [2, [desc]],
      [3, [contrast1]],
    ]);
    const target = scan(2, [
      [1, [finding({})]],
      [
        3,
        [
          finding({
            scanner: "accessibility",
            ruleId: "color-contrast",
            selector: "p.a",
            severity: "high",
          }),
        ],
      ],
      [4, [finding({ ruleId: "h1-missing", path: "/" })]],
    ]);
    const r = compareScans(
      base,
      target,
      [1, 2, 3, 4].map((n) => track(n)),
    );
    expect(r.comparable).toBe(true);
    expect(byNo(r.issues, 1).category).toBe("persistent");
    expect(byNo(r.issues, 2).category).toBe("resolved");
    expect(byNo(r.issues, 2).reason).toContain("re-checked");
    expect(byNo(r.issues, 3).category).toBe("changed");
    expect(byNo(r.issues, 3).changes).toContainEqual({
      field: "severity",
      from: "medium",
      to: "high",
    });
    expect(byNo(r.issues, 3).findings[0]!.category).toBe("changed");
    expect(byNo(r.issues, 4).category).toBe("new");
    expect(r.summary.counts).toEqual({
      new: 1,
      reopened: 0,
      changed: 1,
      resolved: 1,
      persistent: 1,
      not_rechecked: 0,
      newly_checked: 0,
    });
    expect(r.summary.findings).toMatchObject({ new: 1, fixed: 1, changed: 1, persistent: 1 });
    expect(r.summary).toMatchObject({ baseIssues: 3, targetIssues: 3, stepChanges: 0 });
    // Ordered by category: new, reopened, changed, resolved, persistent, …
    expect(r.issues.map((i) => i.category)).toEqual(["new", "changed", "resolved", "persistent"]);
  });

  it("reports findings fixed on some pages and new on others as a changed issue", () => {
    const base = scan(1, [
      [1, [finding({ ruleId: "img-alt" }), finding({ ruleId: "img-alt", path: "/contact" })]],
    ]);
    const target = scan(2, [
      [
        1,
        [
          finding({ ruleId: "img-alt", path: "/contact" }),
          finding({ ruleId: "img-alt", path: "/" }),
        ],
      ],
    ]);
    const item = compareScans(base, target, [track(1)]).issues[0]!;
    expect(item.category).toBe("changed");
    expect(item.findingCounts).toMatchObject({ new: 1, fixed: 1, persistent: 1 });
    expect(item.reason).toContain("1 finding no longer found");
    expect(item.reason).toContain("1 new finding");
  });

  it("never resolves an issue whose page was not analyzed by the target scan", () => {
    const base = scan(1, [[1, [finding({ path: "/contact" })]]]);
    const target = scan(2, [], {
      pages: [page("/"), page("/about"), page("/contact", { httpStatus: 500 })],
    });
    const item = compareScans(base, target, [track(1)]).issues[0]!;
    expect(item.category).toBe("not_rechecked");
    expect(item.reason).toContain("/contact could not be analyzed in scan #2 (HTTP 500)");
    const notCrawled = compareScans(base, scan(2, [], { pages: [page("/")] }), [track(1)]);
    expect(notCrawled.issues[0]!.reason).toContain("/contact was not crawled in scan #2");
    expect(notCrawled.summary.counts.resolved).toBe(0);
  });

  it("does not resolve issues of a scanner that did not run, failed or was not selected", () => {
    const base = scan(1, [[1, [finding({})]]]);
    const failed = withSteps(
      scan(2, []),
      step("seo", "failed", { error: "Step timed out after 600 s" }),
    );
    expect(compareScans(base, failed, [track(1)]).issues[0]).toMatchObject({
      category: "not_rechecked",
      reason: expect.stringContaining("SEO failed in scan #2 (Step timed out after 600 s)"),
    });
    const skipped = withSteps(
      scan(2, []),
      step("seo", "skipped", { statusReason: "Scan cancelled" }),
    );
    expect(compareScans(base, skipped, [track(1)]).issues[0]!.reason).toContain(
      "SEO was skipped in scan #2 (Scan cancelled)",
    );
    const notSelected = scan(2, [], {
      scanners: ["accessibility"],
      steps: scan(2, []).steps.filter((s) => s.stepKey !== "seo"),
    });
    const r = compareScans(base, notSelected, [track(1)]);
    expect(r.issues[0]!.reason).toContain("SEO was not part of scan #2");
    expect(r.warnings.join(" ")).toContain("did not run SEO");
    // An inconclusive step still ran: what it did not find is evidence.
    const inconclusive = withSteps(scan(2, []), step("seo", "inconclusive"));
    expect(compareScans(base, inconclusive, [track(1)]).issues[0]!.category).toBe("resolved");
  });

  it("requires the finding's viewport to be captured again", () => {
    const f = () =>
      finding({ scanner: "responsive", ruleId: "horizontal-overflow", viewport: "mobile" });
    const base = scan(1, [[1, [f()]]]);
    const noMobile = scan(2, [], { viewports: ["desktop"] });
    expect(compareScans(base, noMobile, [track(1)]).issues[0]!.reason).toContain(
      "The mobile viewport was not part of scan #2",
    );
    const failedCapture = scan(2, [], {
      pages: [
        page("/"),
        page("/about", {
          captures: [
            { viewport: "desktop", error: null },
            { viewport: "mobile", error: "Timeout 30000ms exceeded" },
          ],
        }),
      ],
    });
    expect(compareScans(base, failedCapture, [track(1)]).issues[0]!.reason).toContain(
      "The mobile capture of /about failed in scan #2 (Timeout 30000ms exceeded)",
    );
    expect(compareScans(base, scan(2, []), [track(1)]).issues[0]!.category).toBe("resolved");
  });

  it("treats page-level and same-rule inconclusive checks as not rechecked", () => {
    const f = () => finding({ scanner: "accessibility", ruleId: "color-contrast", selector: "p" });
    const base = scan(1, [[1, [f()]]]);
    const gap = (check: string, reason: string) =>
      withSteps(
        scan(2, []),
        step("accessibility", "completed", {
          checks: {
            evaluated: 10,
            inconclusive: [{ check, reason, pageUrl: `${SITE}/about` }],
            inconclusiveTotal: 1,
          },
        }),
      );
    expect(
      compareScans(base, gap("axe-core analysis", "Could not analyze at desktop: crashed"), [
        track(1),
      ]).issues[0],
    ).toMatchObject({ category: "not_rechecked", reason: expect.stringContaining("crashed") });
    expect(
      compareScans(base, gap("color-contrast: Elements must meet…", "needs manual review"), [
        track(1),
      ]).issues[0]!.category,
    ).toBe("not_rechecked");
    // An unrelated rule that needs review does not make this rule unverified.
    expect(
      compareScans(base, gap("aria-valid-attr: …", "needs manual review"), [track(1)]).issues[0]!
        .category,
    ).toBe("resolved");
  });

  it("does not resolve broken links when the link checker hit its limit", () => {
    const base = scan(1, [
      [
        1,
        [
          finding({
            scanner: "links",
            ruleId: "link-broken",
            path: null,
            selector: "https://shop.example/x",
          }),
        ],
      ],
    ]);
    const limited = withSteps(
      scan(2, []),
      step("links", "completed", {
        checks: {
          evaluated: 500,
          inconclusive: [
            {
              check: "Link checks",
              reason: "40 additional unique links were not checked (limit 500)",
              pageUrl: null,
            },
          ],
          inconclusiveTotal: 1,
        },
      }),
    );
    expect(compareScans(base, limited, [track(1)]).issues[0]!.reason).toContain(
      "40 additional unique links were not checked",
    );
  });

  it("does not resolve design or content issues when the reference changed", () => {
    const design = finding({
      scanner: "design",
      ruleId: "design-color-mismatch",
      path: null,
      selector: "colors.text",
    });
    const base = scan(1, [[1, [design]]], { designSpecId: "spec-1", designSpecVersion: 1 });
    const target = scan(2, [], {
      designSpecId: "spec-2",
      designSpecVersion: 2,
      steps: [...scan(2, []).steps, step("design")],
    });
    const baseWithStep = { ...base, steps: [...base.steps, step("design")] };
    const r = compareScans(baseWithStep, target, [track(1)]);
    expect(r.issues[0]!.category).toBe("not_rechecked");
    expect(r.issues[0]!.reason).toContain("version 1 → 2");
    expect(r.warnings.join(" ")).toContain("design reference differs");
    const same = compareScans(
      baseWithStep,
      { ...target, designSpecId: "spec-1", designSpecVersion: 1 },
      [track(1)],
    );
    expect(same.issues[0]!.category).toBe("resolved");

    const content = finding({ scanner: "content", ruleId: "content-missing" });
    const cBase = scan(1, [[1, [content]]], {
      contentSnapshotHash: "a",
      steps: [...scan(1, []).steps, step("content")],
    });
    const cTarget = scan(2, [], {
      contentSnapshotHash: "b",
      steps: [...scan(2, []).steps, step("content")],
    });
    expect(compareScans(cBase, cTarget, [track(1)]).issues[0]!.reason).toContain(
      "approved content documents or their page mapping changed",
    );
  });

  it("reports issues the base scan could not have seen as newly checked, not new", () => {
    const base = scan(1, [], { pages: [page("/")] });
    const target = scan(2, [[1, [finding({ path: "/contact" })]]]);
    const r = compareScans(base, target, [track(1)]);
    expect(r.issues[0]).toMatchObject({
      category: "newly_checked",
      reason: expect.stringContaining("/contact was not crawled in scan #1"),
    });
    const baseNoSeo = withSteps(scan(1, []), step("seo", "failed", { error: "boom" }));
    expect(compareScans(baseNoSeo, target, [track(1)]).issues[0]!.category).toBe("newly_checked");
    expect(r.summary.counts.new).toBe(0);
  });

  it("partly re-checked issues are not resolved and say how many findings were not re-checked", () => {
    const base = scan(1, [
      [1, [finding({}), finding({ path: "/contact" }), finding({ path: "/" })]],
    ]);
    const target = scan(2, [], { pages: [page("/"), page("/about")] });
    const item = compareScans(base, target, [track(1)]).issues[0]!;
    expect(item.category).toBe("not_rechecked");
    expect(item.reason).toContain("1 of 3 findings could not be re-checked");
    expect(item.findingCounts).toMatchObject({ fixed: 2, not_rechecked: 1 });
  });

  it("keeps an issue persistent when the only difference is a page that was not re-checked", () => {
    const base = scan(1, [[1, [finding({}), finding({ path: "/contact" })]]]);
    const target = scan(2, [[1, [finding({})]]], { pages: [page("/"), page("/about")] });
    const item = compareScans(base, target, [track(1)]).issues[0]!;
    expect(item.category).toBe("persistent");
    expect(item.changes).toEqual([]);
    expect(item.reason).toContain("1 finding could not be re-checked by scan #2");
  });

  it("does not call findings 'the same' when the target also found one on a newly checked page", () => {
    // Scan #1 could not analyze /contact; scan #2 did and found the issue there as well.
    const base = scan(1, [[1, [finding({})]]], { pages: [page("/"), page("/about")] });
    const target = scan(2, [[1, [finding({}), finding({ path: "/contact" })]]]);
    const item = compareScans(base, target, [track(1)]).issues[0]!;
    expect(item.category).toBe("persistent");
    expect(item.findingCounts).toMatchObject({ persistent: 1, newly_checked: 1 });
    expect(item.reason).not.toMatch(/with the same (severity, verdict and )?findings/);
    expect(item.reason).toContain("1 finding on parts scan #1 could not check");
  });

  it("marks issues reopened by the target scan, and issues that came back after a scan without them", () => {
    const base = scan(4, [[1, [finding({})]]]);
    const target = scan(5, [
      [1, [finding({})]],
      [2, [finding({ ruleId: "structured-data-invalid", path: "/" })]],
      [3, [finding({ ruleId: "h1-missing", path: "/" })]],
    ]);
    const r = compareScans(base, target, [
      track(1, { status: "reopened", reopenedByTarget: { at: "2026-10-05T10:00:00Z" } }),
      track(2, { lastSeenBeforeBase: 2 }),
      track(3),
    ]);
    expect(byNo(r.issues, 1)).toMatchObject({
      category: "reopened",
      trackStatus: "reopened",
      reason: expect.stringContaining("marked resolved"),
    });
    expect(byNo(r.issues, 2)).toMatchObject({
      category: "reopened",
      reason: "Found in scan #2, not found by scan #4, and found again by scan #5.",
    });
    expect(byNo(r.issues, 3).category).toBe("new");
    // A reappearance the base scan could not have seen stays "newly checked".
    const blind = compareScans({ ...base, pages: [page("/about")] }, target, [
      track(1),
      track(2, { lastSeenBeforeBase: 2 }),
      track(3),
    ]);
    expect(byNo(blind.issues, 2).category).toBe("newly_checked");
  });

  it("keeps unable-to-verify states visible and never treats them as resolved", () => {
    const base = scan(1, [[1, [finding({})]]]);
    const target = scan(2, [[1, [finding({ verdict: "inconclusive" })]]]);
    const r = compareScans(base, target, [track(1)]);
    expect(r.issues[0]!.category).toBe("changed");
    expect(r.issues[0]!.reason).toContain("verdict confirmed → unable to verify");
    expect(r.summary.targetUnableToVerify).toBe(1);
    // inconclusive and unable_to_verify are the same state.
    const same = compareScans(
      scan(1, [[1, [finding({ verdict: "inconclusive" })]]]),
      scan(2, [[1, [finding({ verdict: "unable_to_verify" })]]]),
      [track(1)],
    );
    expect(same.issues[0]!.category).toBe("persistent");
    const review = compareScans(base, scan(2, [[1, [finding({ verdict: "potential" })]]]), [
      track(1),
    ]);
    expect(review.issues[0]!.reason).toContain("verdict confirmed → needs review");
    expect(review.summary.targetNeedsReview).toBe(1);
  });

  it("pairs the same element when its viewport class changed", () => {
    const a = finding({
      scanner: "accessibility",
      ruleId: "image-alt",
      selector: "img",
      viewport: null,
    });
    const b = finding({
      scanner: "accessibility",
      ruleId: "image-alt",
      selector: "img",
      viewport: "desktop",
    });
    const item = compareScans(scan(1, [[1, [a]]]), scan(2, [[1, [b]]]), [track(1)]).issues[0]!;
    expect(item.category).toBe("changed");
    expect(item.findings[0]!.changes).toEqual([{ field: "viewport", from: null, to: "desktop" }]);
  });

  it("treats varying lab measurements as differences, not changes, unless a threshold is crossed", () => {
    const perf = (over: FindingSpec) =>
      finding({
        scanner: "performance",
        ruleId: "lcp-slow",
        severity: "high",
        expected: "≤ 2500 ms",
        ...over,
      });
    const base = scan(1, [[1, [perf({ actual: "4232 ms", viewport: "desktop" })]]], {
      scanners: [...SCANNERS, "performance"],
      steps: [...scan(1, []).steps, step("performance")],
    });
    const target = (over: FindingSpec) =>
      scan(2, [[1, [perf(over)]]], {
        scanners: [...SCANNERS, "performance"],
        steps: [...scan(2, []).steps, step("performance")],
      });
    // Another value and another worst viewport: same issue, same severity → persistent.
    const noise = compareScans(base, target({ actual: "4180 ms", viewport: "mobile" }), [track(1)]);
    const item = noise.issues[0]!;
    expect(item.category).toBe("persistent");
    expect(item.findings[0]).toMatchObject({
      category: "persistent",
      changes: [
        { field: "actual", from: "4232 ms", to: "4180 ms", measurement: true },
        { field: "viewport", from: "desktop", to: "mobile", measurement: true },
      ],
    });
    expect(item.reason).toContain("lab measurements vary between page loads");
    expect(noise.summary.counts.changed).toBe(0);
    // Crossing a threshold (poor → needs improvement) is a change.
    const better = compareScans(
      base,
      target({ actual: "3100 ms", viewport: "desktop", severity: "medium" }),
      [track(1)],
    );
    expect(better.issues[0]!.category).toBe("changed");
    expect(better.issues[0]!.changes).toContainEqual({
      field: "severity",
      from: "high",
      to: "medium",
    });
    // Other scanners' observed values are deterministic: a different value is a change.
    const seo = compareScans(
      scan(1, [[1, [finding({ actual: "12 characters" })]]]),
      scan(2, [[1, [finding({ actual: "14 characters" })]]]),
      [track(1)],
    );
    expect(seo.issues[0]!.category).toBe("changed");
  });
});

describe("compareScans: comparability", () => {
  it("is not comparable without issue records but still compares scanner steps", () => {
    const old = scan(1, [[1, [finding({})]]]);
    old.steps = old.steps.filter((s) => s.stepKey !== "ai" && s.stepKey !== "grounding");
    const r = compareScans(old, scan(2, [[1, [finding({})]]]), [track(1)]);
    expect(r.comparable).toBe(false);
    expect(r.notComparable[0]).toContain("Scan #1 ran before issue tracking existed");
    expect(r.issues).toEqual([]);
    expect(r.summary.counts.new + r.summary.counts.resolved).toBe(0);
    expect(r.steps.find((s) => s.stepKey === "grounding")!.direction).toBe("added");

    const failedGrounding = withSteps(
      scan(2, []),
      step("grounding", "failed", { error: "db down" }),
    );
    const r2 = compareScans(scan(1, []), failedGrounding, []);
    expect(r2.comparable).toBe(false);
    expect(r2.notComparable[0]).toBe(
      "Scan #2 has no issue records: evidence validation failed (db down).",
    );
    expect(r2.target.issuesAvailable).toBe(false);
  });

  it("reports scanner status changes with a direction", () => {
    const base = withSteps(scan(1, []), step("links", "failed"), step("seo", "completed"));
    const target = withSteps(
      scan(2, []),
      step("links", "completed"),
      step("seo", "failed"),
      step("responsive", "inconclusive"),
    );
    const steps = compareScans(base, target, []).steps;
    const dir = (k: string) => steps.find((s) => s.stepKey === k)!.direction;
    expect([dir("links"), dir("seo"), dir("responsive"), dir("crawl")]).toEqual([
      "better",
      "worse",
      "worse",
      "same",
    ]);
    expect(steps.find((s) => s.stepKey === "seo")!.label).toBe("SEO");
  });

  it("warns about different settings and unfinished coverage", () => {
    const base = scan(1, [], {
      viewports: ["desktop", "mobile"],
      status: "completed_with_failures",
    });
    const target = scan(2, [], {
      viewports: ["desktop"],
      websiteUrl: "https://www.shop.example/",
      maxPages: 50,
      scanners: [...SCANNERS, "security"],
      steps: [...scan(2, []).steps, step("security")],
    });
    const w = compareScans(base, target, []).warnings.join("\n");
    expect(w).toContain("different website URLs");
    expect(w).toContain("different viewports");
    expect(w).toContain("Crawl limits differ");
    expect(w).toContain("Scan #1 did not run Security; issues from it are newly checked, not new.");
    expect(w).toContain("Scan #1 completed with failures");
  });

  it("refuses scans of different projects or in the wrong order", () => {
    expect(() => compareScans(scan(2, []), scan(1, []), [])).toThrow(/older/);
    expect(() => compareScans(scan(1, []), { ...scan(2, []), projectId: "p2" }, [])).toThrow(
      /different projects/,
    );
  });
});

describe("pageKey", () => {
  it("is site-relative and ignores tracking parameters, fragments and parameter order", () => {
    expect(pageKey("https://a.example/about?utm_source=x&b=2&a=1#top")).toBe("/about?a=1&b=2");
    expect(pageKey("http://www.a.example/about")).toBe("/about");
    expect(pageKey("mailto:x@example.com")).toBeNull();
    expect(pageKey("not a url")).toBeNull();
  });
});
