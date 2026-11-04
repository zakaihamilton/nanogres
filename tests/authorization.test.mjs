import { test } from "node:test";
import assert from "node:assert/strict";
import { actionFor } from "../src/lib/nanogres-actions.ts";

test("maps read and management operations to separate permissions", () => {
  process.env.PERMINISTER_PRODUCT_ID = "Nanogres";
  for (const resource of ["overview", "databases", "roles", "backups", "activity"]) {
    assert.equal(actionFor("GET", [resource]), "nanogres:workspace:read");
  }
  for (const resource of ["databases", "roles", "backups", "restore-uploads"]) {
    assert.equal(actionFor("POST", [resource]), "nanogres:members:manage");
  }
  assert.equal(actionFor("DELETE", ["databases", "project"]), "nanogres:members:manage");
  assert.equal(
    actionFor("PUT", ["restore-uploads", "id", "chunks", "0"]),
    "nanogres:members:manage",
  );
  assert.equal(actionFor("DELETE", ["roles", "admin"]), null);
  assert.equal(actionFor("GET", ["unknown"]), null);
  assert.equal(actionFor("PUT", ["restore-uploads"]), null);
});

test("fails closed when the product identifier is missing", () => {
  delete process.env.PERMINISTER_PRODUCT_ID;
  assert.equal(actionFor("GET", ["databases"]), null);
  assert.equal(actionFor("POST", ["backups"]), null);
});
