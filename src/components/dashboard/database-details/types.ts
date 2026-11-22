export type Tab = "overview" | "schema" | "queries" | "backups" | "extensions";

export const tabOrder: Tab[] = ["overview", "schema", "queries", "backups", "extensions"];

export type PgvectorExtension = {
  name: "vector";
  displayName: "pgvector";
  available: boolean;
  enabled: boolean;
  version: string | null;
};

type ColumnMeta = {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  ordinalPosition: number;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
};

type IndexMeta = {
  name: string;
  definition: string;
  sizeBytes: number;
  isUnique: boolean;
  isPrimary: boolean;
};

export type TableMeta = {
  name: string;
  kind: string;
  estimatedRows: number;
  totalSizeBytes: number;
  tableSizeBytes: number;
  indexSizeBytes: number;
  columns: ColumnMeta[];
  indexes: IndexMeta[];
};

type SchemaMeta = {
  name: string;
  tables: TableMeta[];
};

export type SchemaResponse = {
  schemas: SchemaMeta[];
};

export type ActiveQuery = {
  pid: number;
  userName: string;
  database: string;
  clientAddress: string;
  applicationName: string;
  state: string;
  queryStart: string;
  durationSeconds: number;
  query: string;
};
