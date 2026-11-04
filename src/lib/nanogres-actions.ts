export function actionFor(method: string, segments: string[]): string | null {
  const [resource, identifier, subResource] = segments;
  const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase();
  if (!productId) return null;
  const read = `${productId}:workspace:read`;
  const manage = `${productId}:members:manage`;

  if (method === "GET") {
    if (["overview", "databases", "roles", "backups", "activity"].includes(resource)) {
      if (
        resource === "databases" &&
        identifier &&
        (subResource === "schema" || subResource === "queries")
      ) {
        return read;
      }
      if (resource === "activity" && identifier === "queries") {
        return read;
      }
      if (!subResource) return read;
    }
    if (resource === "events" && identifier === "stream") return read;
  }

  if (method === "POST") {
    if (["databases", "roles", "backups", "restore-uploads", "query"].includes(resource)) {
      return manage;
    }
    if (resource === "activity" && identifier === "queries" && segments[3] === "terminate") {
      return manage;
    }
  }

  if (method === "PUT" && resource === "restore-uploads" && identifier) return manage;
  if (method === "DELETE" && resource === "databases" && identifier) return manage;
  if (method === "DELETE" && resource === "restore-uploads" && identifier) return manage;
  return null;
}
