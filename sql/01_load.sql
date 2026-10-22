-- 01_load.sql — load generated data. Run from the project root:
--   snow sql -c zelis_c2c -f sql/01_load.sql
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

remove @RAW.LOAD;
put file://datagen/out/tables/*.csv @RAW.LOAD auto_compress = true overwrite = true;
put file://datagen/out/attachments/*.pdf @RAW.ATTACH_SOURCE auto_compress = false overwrite = true;
put file://datagen/out/docs/*.pdf @CORE.DOCS auto_compress = false overwrite = true;
alter stage CORE.DOCS refresh;

copy into CORE.PAYERS from @RAW.LOAD/payers.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.FEE_SCHEDULE from @RAW.LOAD/fee_schedule.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.EDIT_PAIRS from @RAW.LOAD/edit_pairs.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.PROVIDER_ORGS from @RAW.LOAD/provider_orgs.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.PROVIDERS from @RAW.LOAD/providers.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.BANK_ACCOUNTS from @RAW.LOAD/bank_accounts.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.CONTRACTS from @RAW.LOAD/contracts.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into CORE.CONTRACT_CARVEOUTS from @RAW.LOAD/contract_carveouts.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into RAW.CLAIMS_SOURCE from @RAW.LOAD/claims_source.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into RAW.CLAIM_LINES_SOURCE from @RAW.LOAD/claim_lines_source.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into RAW.ATTACHMENTS_SOURCE from @RAW.LOAD/attachments_source.csv.gz file_format = RAW.CSV_FMT match_by_column_name = case_insensitive;
copy into OPS.GROUND_TRUTH (claim_id, scenario, expected_route, expected_exception_type, expected_decision,
    expected_allowed_amt, expected_line_actions, key_evidence, notes)
  from (select $1, $2, $3, nullif($4,''), $5, $6, parse_json($7), parse_json($8), $9 from @RAW.LOAD/ground_truth.csv.gz)
  file_format = (type = csv skip_header = 1 field_optionally_enclosed_by = '"');

select 'claims' t, count(*) n from RAW.CLAIMS_SOURCE union all select 'lines', count(*) from RAW.CLAIM_LINES_SOURCE
union all select 'attachments', count(*) from RAW.ATTACHMENTS_SOURCE union all select 'truth', count(*) from OPS.GROUND_TRUTH
union all select 'contracts', count(*) from CORE.CONTRACTS union all select 'orgs', count(*) from CORE.PROVIDER_ORGS
union all select 'banks', count(*) from CORE.BANK_ACCOUNTS union all select 'docs', count(*) from directory(@CORE.DOCS);
