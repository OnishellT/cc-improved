import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEdits, dependencyNames, inScope, installersIn, isAgentlintAccept, isInteractiveAgentlint, isManifest, isMigration, newDependencies, toRelative } from "../lib/triggers.ts";

test("installersIn", () => {
  assert.deepEqual(installersIn("npm install"), []);
  assert.deepEqual(installersIn("npm i -D zod@3 @types/node"), ["zod", "@types/node"]);
  assert.deepEqual(installersIn("cd x && pnpm add lodash; yarn add react"), ["lodash", "react"]);
  assert.deepEqual(installersIn("pip install -r requirements.txt"), []);
  assert.deepEqual(installersIn("pip install requests==2.0 flask"), ["requests", "flask"]);
  assert.deepEqual(installersIn("cargo add serde"), ["serde"]);
  assert.deepEqual(installersIn("go get github.com/a/b"), ["github.com/a/b"]);
  assert.deepEqual(installersIn("ls -la"), []);
  assert.deepEqual(installersIn("sudo gem install rails"), ["rails"]);
  assert.deepEqual(installersIn("composer require monolog/monolog"), ["monolog/monolog"]);
  assert.deepEqual(installersIn("uv add httpx"), ["httpx"]);
  assert.deepEqual(installersIn("poetry add rich"), ["rich"]);
  assert.deepEqual(installersIn("bun add hono"), ["hono"]);
  assert.deepEqual(installersIn("python3 -m pip install -e ."), []);
});

test("dependencyNames", () => {
  assert.deepEqual([...dependencyNames("package.json", '{"dependencies":{"a":"1"},"devDependencies":{"b":"1"}}')!], ["a", "b"]);
  assert.equal(dependencyNames("package.json", "{bad"), undefined);
  assert.deepEqual([...dependencyNames("requirements.txt", "Flask>=2\n# c\nrequests\n")!], ["flask", "requests"]);
  assert.deepEqual([...dependencyNames("go.mod", "module x\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n")!], ["github.com/a/b"]);
  assert.deepEqual([...dependencyNames("Cargo.toml", '[package]\nname="x"\n[dependencies]\nserde = "1"\ntokio = { version = "1" }\n[dev-dependencies.foo]\nversion="1"\n')!].sort(), ["foo", "serde", "tokio"]);
  const py = '[project]\nname = "x"\ndependencies = [\n  "requests>=2",\n  "flask",\n]\n[project.optional-dependencies]\ndev = ["pytest"]\n';
  assert.deepEqual([...dependencyNames("pyproject.toml", py)!].sort(), ["flask", "pytest", "requests"]);
});

test("isMigration, toRelative, applyEdits", () => {
  for (const p of ["db/migrate/1.rb", "src/migrations/a.ts", "alembic/versions/x.py", "prisma/schema.prisma", "q.sql"]) assert.ok(isMigration(p), p);
  assert.ok(!isMigration("src/app.ts"));
  assert.equal(toRelative("/r", "/r/src/a.ts"), "src/a.ts");
  assert.equal(toRelative("/r", "src/a.ts"), "src/a.ts");
  assert.equal(applyEdits("a b", [{ oldText: "b", newText: "c" }]), "a c");
  assert.equal(applyEdits("b b", [{ oldText: "b", newText: "c" }]), undefined);
});


test("isManifest", () => {
  for (const p of ["package.json", "a/pyproject.toml", "requirements-dev.txt", "go.mod", "Cargo.toml", "Gemfile", "composer.json"]) assert.ok(isManifest(p), p);
  assert.ok(!isManifest("src/package.ts"));
});

test("newDependencies", () => {
  assert.deepEqual(newDependencies(new Set(["a"]), new Set(["a", "b"])), ["b"]);
  assert.deepEqual(newDependencies(new Set(["a"]), new Set(["a"])), []);
  assert.equal(newDependencies(undefined, new Set(["a"])), undefined);
  assert.equal(newDependencies(new Set(["a"]), undefined), undefined);
});

test("inScope", () => {
  const plan = { files: ["src/a.ts", "lib/"] };
  assert.ok(inScope(plan, "src/a.ts"));
  assert.ok(inScope(plan, "lib/x/y.ts"));
  assert.ok(!inScope(plan, "src/b.ts"));
  assert.ok(inScope(plan, "src/b.ts", ["src/b.ts"]));
  assert.ok(!inScope(undefined, "src/a.ts"));
});

test("agentlint commands", () => {
  assert.ok(isInteractiveAgentlint("agentlint review"));
  assert.ok(isInteractiveAgentlint("npx agentlint -- review"));
  assert.ok(isInteractiveAgentlint("agentlint next --wizard"));
  assert.ok(!isInteractiveAgentlint("agentlint rules scan"));
  assert.ok(isAgentlintAccept("agentlint accept R1"));
  assert.ok(isAgentlintAccept("agentlint approve R1"));
  assert.ok(!isAgentlintAccept("agentlint next --format json"));
});
