export function actionFor(method: string, segments: string[]): string | null {
  const [resource, identifier] = segments;
  const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase();
  if (!productId) return null;
  const read = `${productId}:workspace:read`;
  const manage = `${productId}:members:manage`;
  if (method === "GET") {
    if (["overview", "databases", "roles", "backups", "activity"].includes(resource)) return read;
  }
  if (method === "POST") {
    if (["databases", "roles", "backups", "restore-uploads"].includes(resource)) return manage;
  }
  if (method === "PUT" && resource === "restore-uploads" && identifier) return manage;
  if (method === "DELETE" && resource === "databases" && identifier) return manage;
  if (method === "DELETE" && resource === "restore-uploads" && identifier) return manage;
  return null;
}
