import { test } from "node:test";
import assert from "node:assert/strict";
import { actionFor } from "../src/lib/nanogres-actions.ts";

test("maps read and management operations to separate permissions", () => {
  process.env.PERMINISTER_PRODUCT_ID = "Nanogres";
  for (const resource of ["overview", "databases", "roles", "backups", "transfers", "activity"]) {
    assert.equal(actionFor("GET", [resource]), "nanogres:database:read");
  }
  for (const resource of ["databases", "roles", "backups", "transfers", "restore-uploads"]) {
    assert.equal(actionFor("POST", [resource]), "nanogres:database:manage");
  }
  assert.equal(actionFor("DELETE", ["databases", "project"]), "nanogres:database:manage");
  assert.equal(
    actionFor("DELETE", ["transfers", "0123456789abcdef0123456789abcdef"]),
    "nanogres:database:manage",
  );
  assert.equal(
    actionFor("PUT", ["restore-uploads", "id", "chunks", "0"]),
    "nanogres:database:manage",
  );
  assert.equal(actionFor("DELETE", ["roles", "admin"]), null);
  assert.equal(actionFor("GET", ["unknown"]), null);
  assert.equal(actionFor("PUT", ["restore-uploads"]), null);
  assert.equal(actionFor("DELETE", ["transfers"]), null);
  assert.equal(actionFor("POST", ["query"]), "nanogres:database:manage");
  assert.equal(actionFor("GET", ["databases", "my_db", "schema"]), "nanogres:database:read");
  assert.equal(actionFor("GET", ["databases", "my_db", "queries"]), "nanogres:database:read");
  assert.equal(actionFor("GET", ["events", "stream"]), "nanogres:database:read");
});

test("fails closed when the product identifier is missing", () => {
  delete process.env.PERMINISTER_PRODUCT_ID;
  assert.equal(actionFor("GET", ["databases"]), null);
  assert.equal(actionFor("POST", ["backups"]), null);
});
