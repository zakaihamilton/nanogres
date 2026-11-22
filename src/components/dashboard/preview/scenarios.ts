import type { DatabaseStorage, StorageDisk } from "../storage-capacity";

export type PreviewScenario =
  | "healthy"
  | "disconnected-server"
  | "empty-cluster"
  | "many-databases"
  | "long-names"
  | "near-full-storage"
  | "storage-full"
  | "connection-saturation"
  | "backups-stale"
  | "backups-failed"
  | "backups-unconfigured"
  | "read-only"
  | "validation-errors"
  | "delete-error"
  | "sql-error"
  | "sql-empty-results"
  | "sql-wide-results"
  | "sql-no-database";

export type DatabaseRow = DatabaseStorage & {
  name: string;
  owner: string;
  size: string;
  sizeBytes: number;
  growthHeadroomBytes: number;
  recommendedMaxBytes: number;
  hardLimitEnforced: boolean;
  systemDatabase: boolean;
  connections: string;
  updated: string;
  encoding: string;
  state: "Healthy" | "Idle" | "Maintenance";
};

const gib = 1024 ** 3;
const demoDisk: StorageDisk = {
  totalBytes: 40 * gib,
  usedBytes: 13 * gib,
  freeBytes: 27 * gib,
};
const demoGrowthHeadroom = (Math.max(0, demoDisk.freeBytes - gib) * 0.25) / 3;

const demoDatabases: DatabaseRow[] = [
  {
    name: "postgres",
    owner: "postgres",
    size: "16 MB",
    sizeBytes: 16 * 1024 ** 2,
    growthHeadroomBytes: 0,
    recommendedMaxBytes: 16 * 1024 ** 2,
    hardLimitEnforced: false,
    systemDatabase: true,
    connections: "2 / 100",
    updated: "Now",
    encoding: "UTF8",
    state: "Healthy",
  },
  {
    name: "app_main",
    owner: "app_service",
    size: "1.8 GB",
    sizeBytes: 1.8 * gib,
    growthHeadroomBytes: demoGrowthHeadroom,
    recommendedMaxBytes: 1.8 * gib + demoGrowthHeadroom,
    hardLimitEnforced: false,
    systemDatabase: false,
    connections: "8 / 100",
    updated: "2 min ago",
    encoding: "UTF8",
    state: "Healthy",
  },
  {
    name: "event_store",
    owner: "worker_role",
    size: "426 MB",
    sizeBytes: 426 * 1024 ** 2,
    growthHeadroomBytes: demoGrowthHeadroom,
    recommendedMaxBytes: 426 * 1024 ** 2 + demoGrowthHeadroom,
    hardLimitEnforced: false,
    systemDatabase: false,
    connections: "3 / 50",
    updated: "8 min ago",
    encoding: "UTF8",
    state: "Healthy",
  },
  {
    name: "sandbox",
    owner: "dev_role",
    size: "74 MB",
    sizeBytes: 74 * 1024 ** 2,
    growthHeadroomBytes: demoGrowthHeadroom,
    recommendedMaxBytes: 74 * 1024 ** 2 + demoGrowthHeadroom,
    hardLimitEnforced: false,
    systemDatabase: false,
    connections: "0 / 20",
    updated: "3 hours ago",
    encoding: "UTF8",
    state: "Idle",
  },
];

export function databasesForScenario(scenario: PreviewScenario): DatabaseRow[] {
  if (scenario === "disconnected-server" || scenario === "empty-cluster") return [];
  if (scenario === "many-databases") {
    return [
      ...demoDatabases,
      ...Array.from({ length: 20 }, (_, index) => {
        const base = demoDatabases[(index % 3) + 1];
        return {
          ...base,
          name: `tenant_database_${String(index + 1).padStart(2, "0")}`,
          owner: `service_user_${String(index + 1).padStart(2, "0")}`,
          systemDatabase: false,
          connections: `${index % 9} / 50`,
        };
      }),
    ];
  }
  if (scenario === "long-names") {
    return demoDatabases.map((database, index) =>
      index === 1
        ? {
            ...database,
            name: "customer_analytics_and_event_archive_for_regional_operations",
            owner: "distributed_reporting_service_account",
          }
        : database,
    );
  }
  if (scenario === "connection-saturation") {
    return demoDatabases.map((database) =>
      database.name === "app_main"
        ? { ...database, connections: "98 / 100" }
        : database.name === "event_store"
          ? { ...database, connections: "49 / 50" }
          : database,
    );
  }
  return demoDatabases;
}

export function previewDatabaseNamesForScenario(scenario: PreviewScenario): string[] | null {
  if (scenario === "disconnected-server") return null;
  if (scenario === "sql-no-database") return [];
  return databasesForScenario(scenario)
    .filter((database) => !database.systemDatabase)
    .map((database) => database.name);
}

export function diskForScenario(scenario: PreviewScenario): StorageDisk {
  if (scenario === "near-full-storage") {
    return { totalBytes: 40 * gib, usedBytes: 37.5 * gib, freeBytes: 2.5 * gib };
  }
  if (scenario === "storage-full") {
    return { totalBytes: 40 * gib, usedBytes: 39.5 * gib, freeBytes: 0.5 * gib };
  }
  return demoDisk;
}
