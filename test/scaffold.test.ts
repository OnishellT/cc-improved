import { test } from "node:test";
import assert from "node:assert/strict";
import { NAME } from "../lib/index.ts";

test("el núcleo carga", () => {
  assert.equal(NAME, "cc-improved");
});
