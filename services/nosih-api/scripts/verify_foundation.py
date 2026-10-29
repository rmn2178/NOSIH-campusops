"""Verify the Supabase foundation: audit chain, extensions, RLS, storage, realtime."""

from __future__ import annotations

import sys

from sqlalchemy import text

sys.path.insert(0, ".")

from app.database import engine  # noqa: E402


def main() -> None:
    with engine.connect() as conn:
        print("audit:", conn.execute(text("select public.rpc_verify_audit_chain()")).scalar_one())

        print("\nextensions:")
        for row in conn.execute(text("select extname from pg_extension where extname in ('vector','pg_trgm','pgcrypto','uuid-ossp') order by 1")):
            print(" ", row[0])

        print("\npolicies per table:")
        for row in conn.execute(text("select tablename, count(*) from pg_policies where schemaname='public' group by 1 order by 1")):
            print(f"  {row[0]}: {row[1]}")

        print("\nmissing RLS:")
        for row in conn.execute(text(
            "select tablename from pg_tables where schemaname='public' and not rowsecurity order by 1"
        )):
            print(" ", row[0])

        print("\nstorage bucket:", conn.execute(text(
            "select id, public, file_size_limit from storage.buckets where id='complaint-evidence'"
        )).fetchone())

        print("\nrealtime tables:", conn.execute(text(
            "select count(*) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'"
        )).scalar_one())

    with engine.connect() as conn:
        trans = conn.begin()
        conn.execute(text(
            "select public.nosih_append_audit('system@nosih.edu.in','SYSTEM','TEST_AUDIT','SYSTEM','0')"
        ))
        print("\naudit with test row:", conn.execute(text("select public.rpc_verify_audit_chain()")).scalar_one())
        trans.rollback()

    with engine.connect() as conn:
        print("audit after rollback:", conn.execute(text("select public.rpc_verify_audit_chain()")).scalar_one())


if __name__ == "__main__":
    main()
