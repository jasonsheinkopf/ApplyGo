# Evidence datasets

Raw measurement data for rows in the `evidence_records` D1 table, one file per record, named for
its evidence slug.

The database row holds the question, method, sample description, aggregates, conclusion, confidence
and limitations — everything needed to *read* a finding and judge how much weight it carries. These
files hold the per-item rows behind it: the numbers a chart is actually drawn from.

They live in git rather than only in D1 for two reasons. Git is versioned, so a dataset cannot be
silently edited to agree with a later conclusion. And D1 rows are edited through a query tool, where
a 13 KB JSON literal is awkward to write correctly and easy to corrupt — a preservation mechanism
that is hard to use does not get used.

A record's `provenance_json.raw_data_file` names the file. Keep the two in step: if a measurement is
re-run, write a new slug rather than overwriting both, so the earlier finding stays readable.
