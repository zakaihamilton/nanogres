export function actionFor(method: string, segments: string[]): string | null {
  const [resource, identifier, subResource, action] = segments;
  const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase() || "nanogres";
  const read = `${productId}:database:read`;
  const manage = `${productId}:database:manage`;

  if (method === "GET") {
    if (
      segments.length === 1 &&
      [
        "overview",
        "databases",
        "roles",
        "workload-identities",
        "backups",
        "transfers",
        "activity",
      ].includes(resource)
    ) {
      return read;
    }
    if (
      segments.length === 2 &&
      ["databases", "backups", "transfers"].includes(resource) &&
      Boolean(identifier)
    ) {
      return read;
    }
    if (segments.length === 2 && resource === "activity" && identifier === "queries") {
      return read;
    }
    if (segments.length === 2 && resource === "events" && identifier === "stream") {
      return read;
    }
    if (
      segments.length === 3 &&
      resource === "databases" &&
      Boolean(identifier) &&
      ["schema", "queries", "extensions"].includes(subResource)
    ) {
      return read;
    }
  }

  if (method === "POST") {
    if (
      segments.length === 1 &&
      [
        "databases",
        "roles",
        "workload-identities",
        "backups",
        "transfers",
        "restore-uploads",
        "query",
      ].includes(resource)
    ) {
      return manage;
    }
    if (
      segments.length === 3 &&
      resource === "databases" &&
      Boolean(identifier) &&
      ["extensions", "quota", "ddl"].includes(subResource)
    ) {
      return manage;
    }
    if (
      segments.length === 3 &&
      resource === "backups" &&
      Boolean(identifier) &&
      subResource === "restore"
    ) {
      return manage;
    }
    if (
      segments.length === 3 &&
      resource === "restore-uploads" &&
      Boolean(identifier) &&
      subResource === "complete"
    ) {
      return manage;
    }
    if (
      segments.length === 4 &&
      resource === "activity" &&
      identifier === "queries" &&
      Boolean(subResource) &&
      action === "terminate"
    ) {
      return manage;
    }
  }

  if (
    method === "PUT" &&
    segments.length === 4 &&
    resource === "restore-uploads" &&
    Boolean(identifier) &&
    subResource === "chunks" &&
    Boolean(action)
  ) {
    return manage;
  }

  if (
    method === "DELETE" &&
    segments.length === 2 &&
    ["databases", "workload-identities", "restore-uploads", "transfers"].includes(resource) &&
    Boolean(identifier)
  ) {
    return manage;
  }

  return null;
}
