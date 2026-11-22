"""SQL studio query inspection, execution, schema inspection, extensions, DDL, and active queries."""

from __future__ import annotations

import csv
import io
import os
import re
import selectors
import subprocess
import tempfile
import time

from . import config as _config
from . import pg as _pg
from . import quotas_offsite as _quotas_offsite
from . import tenants as _tenants
from .config import (
    ApiError,
    NAME_PATTERN,
    TENANT_NAME_PATTERN,
    backup_lock,
    quota_policy_lock,
)
from .pg import quote_identifier, quote_literal


def _skip_sql_comment(sql: str, index: int) -> int | None:
    """Advance past a `--` line comment or nested `/* ... */` block comment, if present."""
    length = len(sql)
    if sql.startswith("--", index):
        newline = sql.find("\n", index + 2)
        return length if newline < 0 else newline + 1
    if sql.startswith("/*", index):
        depth = 1
        index += 2
        while index < length and depth:
            if sql.startswith("/*", index):
                depth += 1
                index += 2
            elif sql.startswith("*/", index):
                depth -= 1
                index += 2
            else:
                index += 1
        if depth:
            raise ApiError(400, "Query contains an unterminated comment.")
        return index
    return None


def inspect_user_query(sql: str) -> list[str]:
    """Return unquoted SQL words and reject scripts with more than one statement."""
    words: list[str] = []
    index = 0
    statement_ended = False
    length = len(sql)

    while index < length:
        char = sql[index]

        if char.isspace():
            index += 1
            continue
        comment_end = _skip_sql_comment(sql, index)
        if comment_end is not None:
            index = comment_end
            continue
        if char == ";":
            statement_ended = True
            index += 1
            continue
        if statement_ended:
            raise ApiError(400, "Run one SQL statement at a time.")

        if char == "'":
            escape_string = index > 0 and sql[index - 1] in "Ee" and (
                index < 2 or not re.match(r"[A-Za-z0-9_$]", sql[index - 2])
            )
            index += 1
            while index < length:
                if escape_string and sql[index] == "\\":
                    index += 2
                    continue
                if sql[index] == "'":
                    if index + 1 < length and sql[index + 1] == "'":
                        index += 2
                    else:
                        index += 1
                        break
                else:
                    index += 1
            else:
                raise ApiError(400, "Query contains an unterminated string.")
            continue

        if char == '"':
            index += 1
            while index < length:
                if sql[index] == '"':
                    if index + 1 < length and sql[index + 1] == '"':
                        index += 2
                    else:
                        index += 1
                        break
                else:
                    index += 1
            else:
                raise ApiError(400, "Query contains an unterminated identifier.")
            continue

        if char == "$":
            delimiter = re.match(r"\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$", sql[index:])
            if delimiter:
                marker = delimiter.group(0)
                end = sql.find(marker, index + len(marker))
                if end < 0:
                    raise ApiError(400, "Query contains an unterminated dollar-quoted string.")
                index = end + len(marker)
                continue

        # psql -c can execute meta-commands such as `\!` as local shell commands.
        # A bare backslash is not valid SQL; strings and comments were skipped
        # above, so reject it before passing the text to psql.
        if char == "\\":
            raise ApiError(400, "psql meta-commands are not supported; submit SQL only.")

        word = re.match(r"[A-Za-z_][A-Za-z_0-9]*", sql[index:])
        if word:
            words.append(word.group(0).upper())
            index += len(word.group(0))
            continue

        index += 1

    if not words:
        raise ApiError(400, "Query cannot be empty.")
    return words


def parse_database_rename(sql: str, words: list[str]) -> tuple[str, str] | None:
    """Parse the SQL editor's supported, organization-scoped database rename form."""
    if words[:2] != ["ALTER", "DATABASE"]:
        return None

    tokens: list[tuple[str, str]] = []
    index = 0
    while index < len(sql):
        char = sql[index]
        if char.isspace():
            index += 1
            continue
        comment_end = _skip_sql_comment(sql, index)
        if comment_end is not None:
            index = comment_end
            continue
        if char == '"':
            index += 1
            identifier: list[str] = []
            while index < len(sql):
                if sql[index] == '"':
                    if index + 1 < len(sql) and sql[index + 1] == '"':
                        identifier.append('"')
                        index += 2
                    else:
                        index += 1
                        break
                else:
                    identifier.append(sql[index])
                    index += 1
            tokens.append(("identifier", "".join(identifier)))
            continue
        if char.isascii() and (char.isalpha() or char == "_"):
            match = re.match(r"[A-Za-z_][A-Za-z_0-9$]*", sql[index:])
            assert match is not None
            value = match.group(0)
            tokens.append(("word", value.lower()))
            index += len(value)
            continue
        if char == ";":
            tokens.append(("punctuation", char))
            index += 1
            continue
        tokens.append(("other", char))
        index += 1

    if tokens and tokens[-1] == ("punctuation", ";"):
        tokens.pop()

    expected_keywords = {0: "alter", 1: "database", 3: "rename", 4: "to"}
    if (
        len(tokens) != 6
        or any(
            tokens[position] != ("word", keyword) for position, keyword in expected_keywords.items()
        )
        or tokens[2][0] not in {"word", "identifier"}
        or tokens[5][0] not in {"word", "identifier"}
    ):
        raise ApiError(400, "SQL editor supports ALTER DATABASE <name> RENAME TO <name> only.")

    old_name = tokens[2][1]
    new_name = tokens[5][1]
    if not TENANT_NAME_PATTERN.fullmatch(old_name) or not TENANT_NAME_PATTERN.fullmatch(new_name):
        raise ApiError(400, "Database names must use lowercase letters, numbers, and underscores.")
    return old_name, new_name


def rename_organization_database(
    organization_id: object,
    old_logical_name: str,
    new_logical_name: str,
    actor: str | None = None,
) -> None:
    """Rename an idle tenant database and migrate its quota policy entry atomically."""
    org_db_name = _config.resolve("organization_database_name", _tenants.organization_database_name)
    old_name = org_db_name(organization_id, old_logical_name)
    new_name = org_db_name(organization_id, new_logical_name)
    if old_name == new_name:
        raise ApiError(400, "Choose a different name for the database.")

    run_sql = _config.resolve("run_sql", _pg.run_sql)
    read_policy = _config.resolve("read_quota_policy", _quotas_offsite.read_quota_policy)
    write_policy = _config.resolve("write_quota_policy", _quotas_offsite.write_quota_policy)
    reconcile = _config.resolve("request_quota_reconcile", _quotas_offsite.request_quota_reconcile)

    with backup_lock:
        with quota_policy_lock:
            if (
                run_sql(
                    f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(old_name)})"
                )
                != "t"
            ):
                raise ApiError(404, "Database to rename was not found in your organization.")
            if (
                run_sql(
                    f"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = {quote_literal(new_name)})"
                )
                == "t"
            ):
                raise ApiError(409, "A database with the new name already exists.")
            active_sessions = run_sql(
                "SELECT count(*) FROM pg_stat_activity "
                f"WHERE datname = {quote_literal(old_name)} AND pid <> pg_backend_pid()"
            )
            if active_sessions != "0":
                raise ApiError(409, "Close active connections to the database before renaming it.")

            quota_policy = read_policy()
            quota_policy_changed = old_name in quota_policy or new_name in quota_policy
            old_quota = quota_policy.pop(old_name, None)
            quota_policy.pop(new_name, None)
            if old_quota is not None:
                quota_policy[new_name] = old_quota

            run_sql(
                f"ALTER DATABASE {quote_identifier(old_name)} RENAME TO {quote_identifier(new_name)}"
            )
            try:
                if quota_policy_changed:
                    write_policy(quota_policy)
            except OSError as error:
                try:
                    run_sql(
                        f"ALTER DATABASE {quote_identifier(new_name)} RENAME TO {quote_identifier(old_name)}"
                    )
                except ApiError as rollback_error:
                    raise ApiError(
                        503,
                        "The database was renamed, but its storage settings could not be updated. Contact Nanogres support.",
                    ) from rollback_error
                raise ApiError(
                    503, "Could not update database storage settings; the rename was rolled back."
                ) from error

            try:
                reconcile(new_name)
            except ApiError:
                # The periodic reconciler will pick up the renamed database.
                pass

    _config.resolve("record_event", _tenants.record_event)(
        "database.renamed",
        f"Database {old_logical_name} renamed to {new_logical_name}.",
        actor,
        organization_id,
    )


def complete_csv_prefix(output: str) -> str:
    """Keep only complete CSV records when output was cut at the byte limit."""
    in_quotes = False
    last_record_end = 0
    index = 0
    while index < len(output):
        char = output[index]
        if char == '"':
            if in_quotes and index + 1 < len(output) and output[index + 1] == '"':
                index += 2
                continue
            in_quotes = not in_quotes
        elif char == "\n" and not in_quotes:
            last_record_end = index + 1
        index += 1
    return output[:last_record_end]


def run_user_query(
    sql: str,
    organization_id: object,
    database: str,
    read_only: bool = False,
    timeout_seconds: int = 15,
    max_rows: int = 100,
    actor: str | None = None,
) -> dict[str, object]:
    """Execute a single SQL studio query against an organization database with resource caps."""
    database = _config.resolve(
        "require_organization_database", _tenants.require_organization_database
    )(organization_id, database)
    if not sql or not sql.strip():
        raise ApiError(400, "Query cannot be empty.")

    words = _config.resolve("inspect_user_query", inspect_user_query)(sql)
    if words[0] == "COPY":
        raise ApiError(400, "COPY commands are not supported in the SQL editor.")
    database_rename = _config.resolve("parse_database_rename", parse_database_rename)(sql, words)

    timeout_seconds = min(60, max(1, int(timeout_seconds)))
    max_rows = min(1000, max(1, int(max_rows)))
    timeout_ms = timeout_seconds * 1000

    if read_only:
        if words[0] not in {"SELECT", "WITH", "VALUES", "SHOW", "EXPLAIN"}:
            raise ApiError(
                400, "Read-only mode accepts SELECT, WITH, VALUES, SHOW, or EXPLAIN queries."
            )
        if any(
            word in {"INSERT", "UPDATE", "DELETE", "MERGE", "CALL", "DO", "COPY"} for word in words
        ):
            raise ApiError(400, "Read-only mode cannot execute data-changing statements.")
        full_sql = f"BEGIN READ ONLY;\n{sql}"
    else:
        full_sql = sql

    if database_rename is not None:
        old_logical_name, new_logical_name = database_rename
        start_time = time.perf_counter()
        _config.resolve("rename_organization_database", rename_organization_database)(
            organization_id, old_logical_name, new_logical_name, actor
        )
        return {
            "columns": ["status"],
            "rows": [[f"Database {old_logical_name} renamed to {new_logical_name}."]],
            "rowCount": 1,
            "durationMs": round((time.perf_counter() - start_time) * 1000, 2),
            "commandTag": "ALTER DATABASE",
            "truncated": False,
            "renamedDatabase": {"from": old_logical_name, "to": new_logical_name},
        }

    max_output_bytes = 4 * 1024 * 1024
    command = [
        _config.resolve("pg_client", _pg.pg_client)("psql"),
        "--no-psqlrc",
        "--quiet",
        "--csv",
        "--set=ON_ERROR_STOP=1",
        f"--set=FETCH_COUNT={max_rows + 1}",
        "--dbname",
        database,
        "--command",
        full_sql,
    ]
    env = _config.resolve("organization_query_env", _tenants.organization_query_env)(organization_id)
    env["PGOPTIONS"] = f"-c statement_timeout={timeout_ms}"
    start_time = time.perf_counter()
    try:
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as stderr_file:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=stderr_file,
                env=env,
                bufsize=0,
            )
            assert process.stdout is not None
            output_bytes = bytearray()
            output_truncated = False
            deadline = time.monotonic() + timeout_seconds + 5

            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        process.kill()
                        process.wait()
                        raise ApiError(
                            504, f"Query exceeded execution timeout ({timeout_seconds}s)."
                        )

                    ready = selector.select(timeout=min(remaining, 1.0))
                    if not ready:
                        if process.poll() is not None:
                            continue
                        continue

                    chunk = os.read(
                        process.stdout.fileno(),
                        min(65536, max_output_bytes + 1 - len(output_bytes)),
                    )
                    if not chunk:
                        break
                    output_bytes.extend(chunk)
                    if len(output_bytes) > max_output_bytes:
                        output_truncated = True
                        process.kill()
                        break

            process.wait()
            stderr_file.seek(0)
            stderr = stderr_file.read().strip()
    except ApiError:
        raise
    except OSError as error:
        raise ApiError(503, "Nanogres could not start PostgreSQL query execution.") from error

    duration_ms = round((time.perf_counter() - start_time) * 1000, 2)

    if process.returncode != 0 and not output_truncated:
        clean_err = re.sub(r"^psql:[^:]+:[0-9]+:\s*", "", stderr)
        raise ApiError(400, clean_err if clean_err else "Query execution failed.")

    output = bytes(output_bytes[:max_output_bytes]).decode("utf-8", errors="replace")
    if output_truncated:
        output = _config.resolve("complete_csv_prefix", complete_csv_prefix)(output)

    if not output.strip():
        return {
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "durationMs": duration_ms,
            "commandTag": "SUCCESS",
            "truncated": output_truncated,
        }

    try:
        reader = csv.reader(io.StringIO(output))
        columns = next(reader, [])
        data_rows: list[list[str]] = []
        row_truncated = False
        for row in reader:
            if len(data_rows) >= max_rows:
                row_truncated = True
                break
            data_rows.append(row)
        return {
            "columns": columns,
            "rows": data_rows,
            "rowCount": len(data_rows),
            "durationMs": duration_ms,
            "truncated": output_truncated or row_truncated,
        }
    except csv.Error as error:
        raise ApiError(413, "Query output contains a CSV field that is too large.") from error


def get_database_schema(database: str) -> dict[str, object]:
    """Introspect schemas, tables, columns, and indexes for a database."""
    if not NAME_PATTERN.fullmatch(database) and database != "postgres":
        raise ApiError(400, "Invalid database name.")
    schema_sql = """
    SELECT json_build_object(
      'schemas', (
        SELECT COALESCE(json_agg(row_to_json(s)), '[]'::json)
        FROM (
          SELECT n.nspname AS name,
                 (
                   SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.name), '[]'::json)
                   FROM (
                     SELECT c.relname AS name,
                            c.relkind AS kind,
                            c.reltuples::bigint AS "estimatedRows",
                            pg_total_relation_size(c.oid) AS "totalSizeBytes",
                            pg_relation_size(c.oid) AS "tableSizeBytes",
                            pg_indexes_size(c.oid) AS "indexSizeBytes",
                            (
                              SELECT COALESCE(json_agg(row_to_json(col) ORDER BY col."ordinalPosition"), '[]'::json)
                              FROM (
                                SELECT a.attname AS name,
                                       pg_catalog.format_type(a.atttypid, a.atttypmod) AS "type",
                                       NOT a.attnotnull AS nullable,
                                       pg_get_expr(ad.adbin, ad.adrelid) AS "defaultValue",
                                       a.attnum AS "ordinalPosition",
                                       EXISTS (
                                         SELECT 1 FROM pg_constraint con
                                         WHERE con.conrelid = c.oid AND con.contype = 'p' AND a.attnum = ANY(con.conkey)
                                       ) AS "isPrimaryKey",
                                       EXISTS (
                                         SELECT 1 FROM pg_constraint con
                                         WHERE con.conrelid = c.oid AND con.contype = 'f' AND a.attnum = ANY(con.conkey)
                                       ) AS "isForeignKey"
                                FROM pg_attribute a
                                LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
                                WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                              ) col
                            ) AS columns,
                            (
                              SELECT COALESCE(json_agg(row_to_json(idx) ORDER BY idx.name), '[]'::json)
                              FROM (
                                SELECT i.relname AS name,
                                       pg_get_indexdef(i.oid) AS definition,
                                       pg_relation_size(i.oid) AS "sizeBytes",
                                       ix.indisunique AS "isUnique",
                                       ix.indisprimary AS "isPrimary"
                                FROM pg_index ix
                                JOIN pg_class i ON i.oid = ix.indexrelid
                                WHERE ix.indrelid = c.oid
                              ) idx
                            ) AS indexes
                     FROM pg_class c
                     WHERE c.relnamespace = n.oid AND c.relkind IN ('r', 'v', 'm', 'p')
                   ) t
                 ) AS tables
          FROM pg_namespace n
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY n.nspname
        ) s
      )
    )::text
    """
    data = _config.resolve("json_query", _pg.json_query)(schema_sql, database=database)
    return data if isinstance(data, dict) else {"schemas": []}


def pgvector_status(database: str) -> dict[str, object]:
    """Check availability and enabled status of the pgvector extension."""
    if not NAME_PATTERN.fullmatch(database):
        raise ApiError(400, "Invalid database name.")
    status = _config.resolve("json_query", _pg.json_query)(
        """
        SELECT json_build_object(
          'name', 'vector',
          'displayName', 'pgvector',
          'available', EXISTS (
            SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
          ),
          'enabled', EXISTS (
            SELECT 1 FROM pg_extension WHERE extname = 'vector'
          ),
          'version', (
            SELECT extversion FROM pg_extension WHERE extname = 'vector'
          )
        )::text
        """,
        database=database,
    )
    if not isinstance(status, dict):
        raise ApiError(503, "PostgreSQL returned an invalid extension status.")
    return status


def get_database_extensions(
    organization_id: object,
    logical_database: str,
) -> dict[str, object]:
    """Return extension status for an organization's database."""
    database = _config.resolve(
        "require_organization_database", _tenants.require_organization_database
    )(organization_id, logical_database)
    return {"extension": _config.resolve("pgvector_status", pgvector_status)(database)}


def update_database_extension(
    organization_id: object,
    logical_database: str,
    payload: dict[str, object],
    actor: str | None,
) -> dict[str, object]:
    """Enable or disable the pgvector extension on an organization's database."""
    if payload.get("name") != "vector":
        raise ApiError(400, "Only the pgvector extension is supported.")
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise ApiError(400, "enabled must be a boolean.")

    database = _config.resolve(
        "require_organization_database", _tenants.require_organization_database
    )(organization_id, logical_database)
    status_fn = _config.resolve("pgvector_status", pgvector_status)
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    status = status_fn(database)
    if enabled == status["enabled"]:
        return {"extension": status}

    if enabled:
        if not status["available"]:
            raise ApiError(
                409,
                "The pgvector package is not installed for this PostgreSQL server version.",
            )
        run_sql("CREATE EXTENSION IF NOT EXISTS vector", database)
        action = "database.extension.enabled"
        detail = f"pgvector enabled for database {logical_database}."
    else:
        try:
            run_sql("DROP EXTENSION IF EXISTS vector RESTRICT", database)
        except ApiError as error:
            raise ApiError(
                409,
                "Cannot disable pgvector while database objects depend on it. Remove those objects and retry; Nanogres will not cascade-drop them.",
            ) from error
        action = "database.extension.disabled"
        detail = f"pgvector disabled for database {logical_database}."

    _config.resolve("record_event", _tenants.record_event)(action, detail, actor, organization_id)
    return {"extension": status_fn(database)}


_MAINTENANCE_TABLE_SQL = {
    "vacuum": "VACUUM {target}",
    "vacuum_full": "VACUUM FULL {target}",
    "analyze": "ANALYZE {target}",
    "reindex": "REINDEX TABLE {target}",
}

_MAINTENANCE_DATABASE_SQL = {
    "vacuum": "VACUUM",
    "vacuum_full": "VACUUM FULL",
    "analyze": "ANALYZE",
}


def execute_ddl(
    database: str,
    payload: dict[str, object],
    actor: str | None = None,
    organization_id: object | None = None,
) -> dict[str, object]:
    """Execute validated schema DDL or maintenance operations on a tenant database."""
    if not NAME_PATTERN.fullmatch(database) and database != "postgres":
        raise ApiError(400, "Invalid database name.")
    op = str(payload.get("operation", ""))
    label_fn = _config.resolve("tenant_resource_label", _tenants.tenant_resource_label)
    valid_name_fn = _config.resolve("valid_name", _tenants.valid_name)
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    record_event = _config.resolve("record_event", _tenants.record_event)

    database_label = (
        label_fn(organization_id, database) if organization_id is not None else database
    ) or database
    sql_env = (
        _config.resolve("organization_query_env", _tenants.organization_query_env)(organization_id)
        if organization_id is not None
        else None
    )

    if op == "create_table":
        table_name = valid_name_fn(payload.get("name"), "Table name")
        columns_data = payload.get("columns")
        if not isinstance(columns_data, list) or not columns_data:
            raise ApiError(400, "Columns list cannot be empty.")
        col_defs = []
        pk_cols = []
        for col in columns_data:
            if not isinstance(col, dict):
                continue
            col_name = valid_name_fn(col.get("name"), "Column name")
            col_type = str(col.get("type", "text")).strip().upper()
            if not re.fullmatch(r"^[A-Z0-9_ ()]+$", col_type):
                raise ApiError(400, "Invalid column type.")
            nullable = bool(col.get("nullable", True))
            definition = f"{quote_identifier(col_name)} {col_type}"
            if not nullable:
                definition += " NOT NULL"
            if col.get("primaryKey"):
                pk_cols.append(quote_identifier(col_name))
            col_defs.append(definition)
        if pk_cols:
            col_defs.append(f"PRIMARY KEY ({', '.join(pk_cols)})")
        sql = f"CREATE TABLE {quote_identifier(table_name)} (\n  " + ",\n  ".join(col_defs) + "\n);"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            "table.created", f"Table {table_name} created in {database_label}.", actor, organization_id
        )
        return {"created": True, "table": table_name}

    if op == "add_column":
        table_name = valid_name_fn(payload.get("table"), "Table name")
        col_name = valid_name_fn(payload.get("column"), "Column name")
        col_type = str(payload.get("type", "text")).strip().upper()
        if not re.fullmatch(r"^[A-Z0-9_ ()]+$", col_type):
            raise ApiError(400, "Invalid column type.")
        nullable = bool(payload.get("nullable", True))
        sql = (
            f"ALTER TABLE {quote_identifier(table_name)} "
            f"ADD COLUMN {quote_identifier(col_name)} {col_type}"
        )
        if not nullable:
            sql += " NOT NULL"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            "column.added",
            f"Column {col_name} added to {table_name} in {database_label}.",
            actor,
            organization_id,
        )
        return {"added": True, "column": col_name}

    if op == "create_index":
        table_name = valid_name_fn(payload.get("table"), "Table name")
        idx_name = valid_name_fn(payload.get("name"), "Index name")
        cols = payload.get("columns")
        if not isinstance(cols, list) or not cols:
            raise ApiError(400, "Index columns cannot be empty.")
        quoted_cols = [quote_identifier(valid_name_fn(c, "Column")) for c in cols]
        unique = "UNIQUE " if payload.get("unique") else ""
        idx_type = str(payload.get("type", "btree")).lower()
        if idx_type not in {"btree", "hash", "gin", "gist"}:
            idx_type = "btree"
        sql = (
            f"CREATE {unique}INDEX {quote_identifier(idx_name)} "
            f"ON {quote_identifier(table_name)} USING {idx_type} ({', '.join(quoted_cols)});"
        )
        run_sql(sql, database=database, env=sql_env)
        record_event(
            "index.created",
            f"Index {idx_name} created on {table_name} in {database_label}.",
            actor,
            organization_id,
        )
        return {"created": True, "index": idx_name}

    if op == "maintenance":
        action = str(payload.get("action", "")).lower()
        if action not in _MAINTENANCE_TABLE_SQL:
            raise ApiError(400, "Invalid maintenance action.")
        table = payload.get("table")
        if table:
            table_name = valid_name_fn(table, "Table name")
            sql = _MAINTENANCE_TABLE_SQL[action].format(target=quote_identifier(table_name))
        elif action in _MAINTENANCE_DATABASE_SQL:
            sql = _MAINTENANCE_DATABASE_SQL[action]
        else:
            sql = f"REINDEX DATABASE {quote_identifier(database)}"
        run_sql(sql, database=database, env=sql_env)
        record_event(
            f"database.{action}",
            f"{action.upper()} executed in {database_label}.",
            actor,
            organization_id,
        )
        return {"success": True, "action": action}

    raise ApiError(400, f"Unsupported operation: {op}")


def get_active_queries(
    organization_id: object,
    database: str | None = None,
) -> list[dict[str, object]]:
    """Return active `pg_stat_activity` sessions scoped to an organization."""
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    where_clause = "WHERE a.pid <> pg_backend_pid() AND a.state IS NOT NULL"
    where_clause += f" AND left(a.datname, {len(prefix)}) = {quote_literal(prefix)}"
    if database:
        physical_name = _config.resolve(
            "require_organization_database", _tenants.require_organization_database
        )(organization_id, database)
        where_clause += f" AND a.datname = {quote_literal(physical_name)}"
    sql = f"""
    SELECT COALESCE(json_agg(row_to_json(q) ORDER BY q."durationSeconds" DESC), '[]'::json)::text
    FROM (
      SELECT a.pid,
             a.usename AS "userName",
             a.datname AS "database",
             COALESCE(a.client_addr::text, 'local') AS "clientAddress",
             COALESCE(a.application_name, '') AS "applicationName",
             a.state,
             a.query_start AS "queryStart",
             COALESCE(ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - a.query_start))::numeric, 2), 0) AS "durationSeconds",
             a.query,
             a.wait_event_type AS "waitEventType",
             a.wait_event AS "waitEvent"
      FROM pg_stat_activity a
      {where_clause}
    ) q
    """
    rows = _config.resolve("json_query", _pg.json_query)(sql)
    if not isinstance(rows, list):
        return []
    label_fn = _config.resolve("tenant_resource_label", _tenants.tenant_resource_label)
    query_role = _config.resolve("organization_query_role", _tenants.organization_query_role)(
        organization_id
    )
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        logical_database = label_fn(organization_id, row.get("database"))
        physical_user = row.get("userName")
        logical_user = (
            "Nanogres"
            if physical_user == query_role
            else label_fn(organization_id, physical_user)
        )
        result.append(
            {
                **row,
                "database": logical_database or row.get("database"),
                "userName": logical_user or physical_user,
            }
        )
    return result


def terminate_query(
    pid: int,
    organization_id: object,
    signal: str = "cancel",
    actor: str | None = None,
) -> dict[str, object]:
    """Send `pg_cancel_backend` or `pg_terminate_backend` to an organization backend PID."""
    if not isinstance(pid, int) or pid <= 0:
        raise ApiError(400, "Invalid process ID.")
    prefix = _config.resolve("organization_prefix", _tenants.organization_prefix)(organization_id)
    run_sql = _config.resolve("run_sql", _pg.run_sql)
    belongs_to_organization = run_sql(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
        f"WHERE pid = {pid} AND left(datname, {len(prefix)}) = {quote_literal(prefix)})"
    )
    if belongs_to_organization != "t":
        raise ApiError(404, "Query not found.")
    func = "pg_cancel_backend" if signal == "cancel" else "pg_terminate_backend"
    res = run_sql(f"SELECT {func}({pid})")
    success = res == "t"
    _config.resolve("record_event", _tenants.record_event)(
        f"query.{signal}",
        f"{signal.capitalize()} sent to backend pid {pid}.",
        actor,
        organization_id,
    )
    return {"success": success, "pid": pid, "action": signal}
