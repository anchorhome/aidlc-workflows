// covers: function:workspaceSourceState
//
// Anchor patch 0004: Apple/Swift tool output leaves the source boundary by
// name, like `.venv` and `__pycache__` already do. SwiftPM's `.build/`, Xcode's
// `DerivedData/` and `xcuserdata/`, `*.xcresult` test bundles and the
// `.hypothesis/` example database are rewritten by every build or test run, so
// before this patch each run drifted the fingerprint and filled the
// unclaimed-source listing, and Code Generation could not complete
// (anchor-home #294; upstream #1034, #1099). The boundary stays name-based, so
// Git availability still never changes it, and Git-ignored source stays bound.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceSourceState } from "../../core/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupTestProject(created.pop());
});

function sourceProject(): string {
  const project = createTestProject();
  created.push(project);
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "src", "main.swift"), "let main = 1\n");
  return project;
}
const state = (project: string) => {
  const s = workspaceSourceState(project);
  expect(s).not.toBeNull();
  return s!;
};
const paths = (project: string) => [...state(project).listing.keys()].map((k) => k.split("\0")[1]);

// Each output tree, at the depths the tools put them, with source-like files
// inside (DerivedData holds generated .swift and .json).
const OUTPUT = [
  ".build/debug/App.swiftmodule/Project.json",
  "units/.build/checkouts/dep/Sources/Dep.swift",
  "build-cache/DerivedData/App/Build/Intermediates.noindex/Gen.swift",
  "units/App.xcodeproj/xcuserdata/cv.xcuserdatad/xcschemes/xcschememanagement.plist",
  "units/App.xcodeproj/project.xcworkspace/xcuserdata/cv.xcuserdatad/UserInterfaceState.xcuserstate",
  ".build/tests/Run-1.xcresult/Data/data.0~abc",
  "results/AppTests.xcresult/Info.plist",
  "backend/.hypothesis/examples/1a/2b.json",
];
function writeOutput(project: string, variant: string): void {
  for (const rel of OUTPUT) {
    mkdirSync(join(project, rel, ".."), { recursive: true });
    writeFileSync(join(project, rel), `${variant}\n`);
  }
}

describe("anchor 0004 Apple/Swift tool output is outside the source boundary", () => {
  test("build and test output doesn't drift the fingerprint and isn't listed", () => {
    const project = sourceProject();
    const before = state(project).fingerprint;
    writeOutput(project, "run-1");
    expect(state(project).fingerprint).toBe(before);
    writeOutput(project, "run-2");
    expect(state(project).fingerprint).toBe(before);
    const listed = paths(project);
    expect(listed.filter((p) => OUTPUT.some((o) => p === o))).toEqual([]);
    expect(listed).toContain("src/main.swift");
  });

  test("real source still drifts it, including source beside the output trees", () => {
    const project = sourceProject();
    writeOutput(project, "run-1");
    const before = state(project).fingerprint;
    mkdirSync(join(project, "units", "App.xcodeproj"), { recursive: true });
    writeFileSync(join(project, "units", "App.xcodeproj", "project.pbxproj"), "// pbx\n");
    const withProject = state(project).fingerprint;
    expect(withProject).not.toBe(before);
    writeFileSync(join(project, "src", "main.swift"), "let main = 2\n");
    expect(state(project).fingerprint).not.toBe(withProject);
  });

  test("only whole names and the .xcresult suffix match: look-alike source dirs stay bound", () => {
    const project = sourceProject();
    const before = state(project).fingerprint;
    for (const rel of ["src/build-tools/Tool.swift", "src/xcresult/Parse.swift", "src/DerivedDataReader/Read.swift", "src/.hypothesis-notes/n.py"]) {
      mkdirSync(join(project, rel, ".."), { recursive: true });
      writeFileSync(join(project, rel), "let x = 1\n");
    }
    const listed = paths(project);
    expect(state(project).fingerprint).not.toBe(before);
    expect(listed).toContain("src/xcresult/Parse.swift");
    expect(listed).toContain("src/DerivedDataReader/Read.swift");
    expect(listed).toContain("src/.hypothesis-notes/n.py");
  });

  test("registering a path under these names is refused, exactly as under node_modules", () => {
    for (const dir of ["node_modules", ".build", "DerivedData", "Run.xcresult"]) {
      const project = sourceProject();
      writeFileSync(join(project, ".aidlc-source-paths.json"), JSON.stringify({ version: 1, paths: [`${dir}/gen/Schema.swift`] }));
      mkdirSync(join(project, dir, "gen"), { recursive: true });
      writeFileSync(join(project, dir, "gen", "Schema.swift"), "let v = 1\n");
      expect(workspaceSourceState(project)).toBeNull();
    }
  });
});
