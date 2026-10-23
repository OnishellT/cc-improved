import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../skills/", import.meta.url).pathname;
const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "missing frontmatter");
  const out: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as string] = (kv[2] ?? "").trim();
  }
  return out;
}

test("hay skills de método", () => {
  assert.ok(dirs.length >= 9);
});

for (const d of dirs) {
  test(`skill ${d.name}: frontmatter válido`, () => {
    const file = join(root, d.name, "SKILL.md");
    assert.ok(existsSync(file), "SKILL.md missing");
    const fm = frontmatter(readFileSync(file, "utf8"));
    assert.equal(fm["name"], d.name);
    assert.match(fm["name"] ?? "", /^[a-z0-9-]{1,64}$/);
    assert.ok((fm["description"] ?? "").length > 20, "description too short");
    assert.equal(fm["user-invocable"], "false");
    assert.equal(fm["disable-model-invocation"], undefined);
  });

  test(`skill ${d.name}: sin comandos de verificación fijos`, () => {
    const text = readFileSync(join(root, d.name, "SKILL.md"), "utf8");
    assert.doesNotMatch(text, /\b(tsc|eslint|npm (test|run)|pnpm|yarn test)\b/);
  });
}

test("licencias vendorizadas presentes", () => {
  assert.ok(existsSync(join(root, "LICENSE-mattpocock")));
  assert.ok(existsSync(join(root, "LICENSE-pstack")));
});

test("ninguna skill nombra otra skill inexistente", () => {
  const names = new Set(dirs.map((d) => d.name));
  const patterns = [
    /Skill tool with [`"']([a-z0-9-]+)[`"']/g,
    /`([a-z0-9-]+)` skill\b/g,
  ];
  for (const d of dirs) {
    const text = readFileSync(join(root, d.name, "SKILL.md"), "utf8");
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const ref = m[1] as string;
        assert.ok(names.has(ref), `${d.name} references missing skill ${ref}`);
      }
    }
  }
});
