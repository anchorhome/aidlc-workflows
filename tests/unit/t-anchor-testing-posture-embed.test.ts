// covers: file:tools/aidlc-testing-posture.ts, hook:aidlc-plan-approval-guard
//
// Anchor patch 0002 - `testing-posture embed --plan <path>` writes the Testing
// Contract into a Code Generation plan from renderTestingContract(
// resolveTestingPosture(projectDir)), so the block is never hand-copied (#334: a
// copied block loses the literal \n escapes in applicable_notes and the plan
// fails its contract hash). The plan-approval guard admits embed only while its
// target is inside the Code Generation record dir.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlanApprovalPrerequisite } from "../../dist/claude/.claude/hooks/aidlc-plan-approval-guard.ts";
import {
  codeGenerationRecordDir,
  embedTestingContract,
  parseTestingContract,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const INTENTS = join("aidlc", "spaces", "default", "intents");
const UNIT = "u1-embed";

// Multi-line notes are what #334 corrupted: JSON.stringify writes their line
// breaks as literal `\n`, and a hand copy turns them back into real newlines.
const TEAM_MEMORY = `# Team

## Testing Posture

We test after the change lands.
Every unit ships with Bun tests under tests/.
Fixtures are synthetic only.
`;

function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "t-anchor-embed-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "tools"), { recursive: true });
  for (const hook of [
    "aidlc-plan-approval-guard.ts",
    "aidlc-state-transition-guard.ts",
    "aidlc-review-freeze.ts",
    "review-freeze-command.ts",
    "runtime-integrity.ts",
    "aidlc-record-human-turn.ts",
  ]) {
    cpSync(join(AIDLC_SRC, "hooks", hook), join(dir, ".claude", "hooks", hook));
  }
  cpSync(join(AIDLC_SRC, "tools"), join(dir, ".claude", "tools"), { recursive: true });
  mkdirSync(join(dir, INTENTS), { recursive: true });
  mkdirSync(join(dir, "aidlc", "spaces", "default", "memory"), { recursive: true });
  writeFileSync(join(dir, "aidlc", "spaces", "default", "memory", "team.md"), TEAM_MEMORY);
  writeFileSync(
    join(dir, INTENTS, "aidlc-state.md"),
    `# AI-DLC State Tracking

## Project Information
- **Project**: embed fixture
- **Scope**: feature

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
`,
  );
  for (const args of [
    ["init", "-q"],
    ["config", "user.email", "tests@example.com"],
    ["config", "user.name", "AI-DLC Tests"],
    ["add", "-A"],
    ["commit", "-qm", "baseline"],
  ]) {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return dir;
}

function withProject(fn: (proj: string) => void): void {
  const proj = scratchProject();
  try {
    fn(proj);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
}

function planPath(proj: string): string {
  const dir = codeGenerationRecordDir(proj, UNIT);
  mkdirSync(dir, { recursive: true });
  return join(dir, "code-generation-plan.md");
}

// The real dispatch path: the unified entry point routes `engine
// testing-posture embed` to the tool, exactly as the installed binary does.
function embedCli(proj: string, plan: string | null): { code: number; stderr: string } {
  const args = [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "testing-posture", "embed"];
  if (plan !== null) args.push("--plan", plan);
  args.push("--project-dir", proj);
  const r = spawnSync(BUN, args, {
    cwd: proj,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

function renderCli(proj: string): string {
  const r = spawnSync(
    BUN,
    [join(proj, ".claude", "tools", "aidlc.ts"), "engine", "testing-posture", "render", "--project-dir", proj],
    { cwd: proj, encoding: "utf-8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
  );
  expect(r.status).toBe(0);
  return r.stdout;
}

const PLAN_HEAD = "# Code Generation Plan\n\n## Steps\n\n1. Add the verb.\n2. Test it.\n";
const PLAN_TAIL = "## Traceability\n\n| FR1 | Step 1 |\n";

describe("t-anchor testing-posture embed", () => {
  test("the fixture posture carries multi-line notes, the #334 shape", () => {
    withProject((proj) => {
      const contract = resolveTestingPosture(proj);
      expect(contract.applicable_notes.some((note) => note.text.includes("\n"))).toBe(true);
      expect(renderTestingContract(contract)).toContain("\\n");
    });
  });

  test("inserts into a plan with no contract; the result verifies on the first try", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      writeFileSync(plan, PLAN_HEAD);
      const result = embedCli(proj, plan);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const written = readFileSync(plan, "utf-8");
      expect(written.startsWith(PLAN_HEAD)).toBe(true);
      expect(written.endsWith(renderCli(proj))).toBe(true);
      expect(parseTestingContract(written)?.contract_sha256).toBe(
        resolveTestingPosture(proj).contract_sha256,
      );
    });
  });

  test("replaces a hand-copied block whose \\n escapes became real newlines", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      const good = renderTestingContract(resolveTestingPosture(proj));
      const corrupted = good.replaceAll("\\n", "\n");
      expect(corrupted).not.toBe(good);
      writeFileSync(plan, `${PLAN_HEAD}\n${corrupted}\n${PLAN_TAIL}`);
      expect(parseTestingContract(readFileSync(plan, "utf-8"))?.contract_sha256).not.toBe(
        resolveTestingPosture(proj).contract_sha256,
      );
      expect(embedCli(proj, plan).code).toBe(0);
      expect(readFileSync(plan, "utf-8")).toBe(`${PLAN_HEAD}\n${good}\n${PLAN_TAIL}`);
    });
  });

  test("stops at the next H2 and is not fooled by a fenced ``` or a quoted heading", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      const good = renderTestingContract(resolveTestingPosture(proj));
      // A fenced example in the plan body quotes the heading and an H2; neither
      // is the real section, and the real section must end at `## Traceability`.
      const body =
        `${PLAN_HEAD}\n\`\`\`md\n## Testing Contract\n\n## Not a heading\n\`\`\`\n\n`;
      writeFileSync(plan, `${body}## Testing Contract\n\nstale\n\n${PLAN_TAIL}`);
      expect(embedCli(proj, plan).code).toBe(0);
      expect(readFileSync(plan, "utf-8")).toBe(`${body}${good}\n${PLAN_TAIL}`);
    });
  });

  test("the embedded block is byte-identical to render", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      writeFileSync(plan, "");
      expect(embedCli(proj, plan).code).toBe(0);
      expect(readFileSync(plan, "utf-8")).toBe(renderCli(proj));
      expect(readFileSync(plan, "utf-8")).toBe(renderTestingContract(resolveTestingPosture(proj)));
    });
  });

  test("embedding twice leaves the file byte-identical, on insert and on replace", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      for (const start of [PLAN_HEAD, `${PLAN_HEAD}\n## Testing Contract\n\nold\n\n${PLAN_TAIL}`]) {
        writeFileSync(plan, start);
        expect(embedCli(proj, plan).code).toBe(0);
        const once = readFileSync(plan, "utf-8");
        expect(embedCli(proj, plan).code).toBe(0);
        expect(readFileSync(plan, "utf-8")).toBe(once);
      }
    });
  });

  test("a missing or blank --plan throws and never creates a file", () => {
    withProject((proj) => {
      const missing = join(codeGenerationRecordDir(proj, UNIT), "code-generation-plan.md");
      const absent = embedCli(proj, missing);
      expect(absent.code).not.toBe(0);
      expect(existsSync(missing)).toBe(false);
      const blank = embedCli(proj, null);
      expect(blank.code).not.toBe(0);
      expect(blank.stderr).toContain("embed requires a non-blank --plan <path>");
      expect(() => embedTestingContract(missing, resolveTestingPosture(proj))).toThrow();
      expect(existsSync(missing)).toBe(false);
    });
  });
});

describe("t-anchor plan-approval guard admits embed only inside the record dir", () => {
  const engine = (...rest: string[]) => ["engine", "testing-posture", ...rest];

  test("embed into the unit's plan is a prerequisite; outside it is not", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      writeFileSync(plan, PLAN_HEAD);
      const outside = join(proj, "src", "plan.md");
      mkdirSync(join(proj, "src"), { recursive: true });
      writeFileSync(outside, PLAN_HEAD);
      const ctx = { projectDir: proj, cwd: proj };
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", plan, "--unit", UNIT), ctx)).toBe(true);
      // Relative to cwd, as a conductor would type it.
      const rel = join(INTENTS, "construction", UNIT, "code-generation", "code-generation-plan.md");
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", rel, "--unit", UNIT), ctx)).toBe(true);
      // Outside the record dir, a `..` escape, the wrong unit, no context, no plan.
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", outside, "--unit", UNIT), ctx)).toBe(false);
      const escaped = join(codeGenerationRecordDir(proj, UNIT), "..", "..", "..", "..", "..", "..", "src", "plan.md");
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", escaped, "--unit", UNIT), ctx)).toBe(false);
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", plan, "--unit", "other"), ctx)).toBe(false);
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", plan, "--unit", UNIT))).toBe(false);
      expect(isPlanApprovalPrerequisite(engine("embed", "--unit", UNIT), ctx)).toBe(false);
      // A symlink in the record dir that points outside it.
      const link = join(codeGenerationRecordDir(proj, UNIT), "linked-plan.md");
      symlinkSync(outside, link);
      expect(isPlanApprovalPrerequisite(engine("embed", "--plan", link, "--unit", UNIT), ctx)).toBe(false);
    });
  });

  test("the read-only siblings stay prerequisites and other verbs stay guarded", () => {
    for (const verb of ["resolve", "render", "fingerprint", "verify"]) {
      expect(isPlanApprovalPrerequisite(engine(verb))).toBe(true);
    }
    for (const verb of ["begin", "brief"]) {
      expect(isPlanApprovalPrerequisite(engine(verb, "--unit", UNIT))).toBe(false);
    }
  });

  test("the hook lets embed through before approval and still refuses an embed outside", () => {
    withProject((proj) => {
      const plan = planPath(proj);
      writeFileSync(plan, PLAN_HEAD);
      mkdirSync(join(proj, "src"), { recursive: true });
      const outside = join(proj, "src", "plan.md");
      writeFileSync(outside, PLAN_HEAD);
      const hook = (command: string) => {
        const r = spawnSync(BUN, [join(proj, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
          cwd: proj,
          input: JSON.stringify({
            hook_event_name: "PreToolUse",
            tool_name: "Bash",
            tool_input: { command },
            cwd: proj,
          }),
          env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
          encoding: "utf-8",
        });
        return r.status ?? -1;
      };
      const tool = join(proj, ".claude", "tools", "aidlc.ts");
      expect(hook(`aidlc engine testing-posture embed --plan ${plan} --unit ${UNIT}`)).toBe(0);
      expect(hook(`bun ${tool} engine testing-posture embed --plan ${plan} --unit ${UNIT}`)).toBe(0);
      expect(hook(`aidlc engine testing-posture embed --plan ${outside} --unit ${UNIT}`)).toBe(2);
      expect(hook(`aidlc engine testing-posture render`)).toBe(0);
    });
  });
});
