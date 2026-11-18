const productId = process.env.PERMINISTER_PRODUCT_ID?.trim().toLowerCase() || "nanogres";

export async function GET() {
  const read = `${productId}:database:read`;
  const manage = `${productId}:database:manage`;

  return Response.json(
    {
      schemaVersion: 1,
      productId,
      version: "1.0.0",
      roles: [
        {
          id: "database-viewer",
          name: "Database viewer",
          description: "View databases, schemas, backups, and activity.",
          role: "viewer",
          scopeKinds: ["product"],
          actions: [read],
        },
        {
          id: "database-manager",
          name: "Database manager",
          description: "Create and manage databases, roles, backups, and transfers.",
          role: "admin",
          scopeKinds: ["product"],
          actions: [read, manage],
        },
      ],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
