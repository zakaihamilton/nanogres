import assert from "node:assert/strict";
import { test } from "node:test";
import { actionFor } from "../src/lib/nanogres-actions.ts";

test("maps read and management operations to separate permissions", () => {
  process.env.PERMINISTER_PRODUCT_ID = "Nanogres";
  for (const resource of [
    "overview",
    "databases",
    "roles",
    "workload-identities",
    "backups",
    "transfers",
    "activity",
  ]) {
    assert.equal(actionFor("GET", [resource]), "nanogres:database:read");
  }
  for (const resource of [
    "databases",
    "roles",
    "workload-identities",
    "backups",
    "transfers",
    "restore-uploads",
    "query",
  ]) {
    assert.equal(actionFor("POST", [resource]), "nanogres:database:manage");
  }
  assert.equal(actionFor("DELETE", ["databases", "project"]), "nanogres:database:manage");
  assert.equal(
    actionFor("DELETE", ["workload-identities", "0123456789abcdef0123456789abcdef"]),
    "nanogres:database:manage",
  );
  assert.equal(
    actionFor("DELETE", ["transfers", "0123456789abcdef0123456789abcdef"]),
    "nanogres:database:manage",
  );
  assert.equal(
    actionFor("DELETE", ["restore-uploads", "0123456789abcdef0123456789abcdef"]),
    "nanogres:database:manage",
  );
  assert.equal(
    actionFor("PUT", ["restore-uploads", "id", "chunks", "0"]),
    "nanogres:database:manage",
  );
  assert.equal(actionFor("POST", ["databases", "my_db", "quota"]), "nanogres:database:manage");
  assert.equal(actionFor("POST", ["databases", "my_db", "extensions"]), "nanogres:database:manage");
  assert.equal(actionFor("POST", ["databases", "my_db", "ddl"]), "nanogres:database:manage");
  assert.equal(actionFor("POST", ["backups", "a.dump", "restore"]), "nanogres:database:manage");
  assert.equal(actionFor("POST", ["restore-uploads", "id", "complete"]), "nanogres:database:manage");
  assert.equal(
    actionFor("POST", ["activity", "queries", "42", "terminate"]),
    "nanogres:database:manage",
  );
  assert.equal(actionFor("POST", ["databases", "my_db", "unknown"]), null);
  assert.equal(actionFor("POST", ["workload-identities", "extra"]), null);
  assert.equal(actionFor("DELETE", ["databases", "my_db", "extra"]), null);
  assert.equal(actionFor("PUT", ["restore-uploads", "id", "other"]), null);
  assert.equal(actionFor("DELETE", ["roles", "admin"]), null);
  assert.equal(actionFor("GET", ["unknown"]), null);
  assert.equal(actionFor("PUT", ["restore-uploads"]), null);
  assert.equal(actionFor("DELETE", ["transfers"]), null);
  assert.equal(actionFor("GET", ["databases", "my_db", "schema"]), "nanogres:database:read");
  assert.equal(actionFor("GET", ["databases", "my_db", "queries"]), "nanogres:database:read");
  assert.equal(actionFor("GET", ["databases", "my_db", "extensions"]), "nanogres:database:read");
  assert.equal(actionFor("GET", ["activity", "queries"]), "nanogres:database:read");
  assert.equal(actionFor("GET", ["events", "stream"]), "nanogres:database:read");
});

test("defaults to the nanogres product identifier when PERMINISTER_PRODUCT_ID is unset", () => {
  delete process.env.PERMINISTER_PRODUCT_ID;
  assert.equal(actionFor("GET", ["databases"]), "nanogres:database:read");
  assert.equal(actionFor("POST", ["backups"]), "nanogres:database:manage");
  process.env.PERMINISTER_PRODUCT_ID = "Custom_Pg";
  assert.equal(actionFor("GET", ["databases"]), "custom_pg:database:read");
});
