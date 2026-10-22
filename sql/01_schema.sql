-- 01_schema.sql — tables and stages. Idempotent (CREATE OR REPLACE on reference data only).
use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
use database ZELIS_C2C;

-- ---------------------------------------------------------------- stages
create stage if not exists RAW.LOAD comment = 'CSV landing for generated reference + source data';
create stage if not exists RAW.ATTACH_SOURCE
  encryption = (type = 'SNOWFLAKE_SSE') comment = 'Holding area: attachments not yet "received" by the simulator';
create stage if not exists RAW.INTAKE
  encryption = (type = 'SNOWFLAKE_SSE') directory = (enable = true)
  comment = 'Received claim attachments (simulator copies files here as they arrive)';
create stage if not exists CORE.DOCS
  encryption = (type = 'SNOWFLAKE_SSE') directory = (enable = true)
  comment = 'Contracts and payer policies (Cortex Search corpus)';
create stage if not exists OPS.REMITTANCE
  encryption = (type = 'SNOWFLAKE_SSE') directory = (enable = true)
  comment = 'Generated EOPs and 835-style remittance files';

create or replace file format RAW.CSV_FMT type = csv parse_header = true field_optionally_enclosed_by = '"'
  error_on_column_count_mismatch = false
  empty_field_as_null = true null_if = ('');

-- ---------------------------------------------------------------- reference data
create or replace table CORE.PAYERS (
  payer_id string primary key, payer_name string not null, oon_pct number(5,2) not null,
  oon_review_threshold number(18,2) not null, oon_negotiate_threshold number(18,2) not null,
  standard_pct number(5,2) not null);

create or replace table CORE.FEE_SCHEDULE (
  code string primary key, description string not null, base_rate number(18,2) not null,
  bilateral_eligible boolean not null, category string not null);

create or replace table CORE.MODIFIER_FACTORS (modifier string primary key, factor number(6,4) not null, meaning string);
insert into CORE.MODIFIER_FACTORS values
  ('50',1.5,'Bilateral (priced on one unit)'), ('51',0.5,'Multiple procedure'), ('26',0.4,'Professional component'),
  ('TC',0.6,'Technical component'), ('59',1,'Distinct procedural service'), ('XS',1,'Separate structure'),
  ('XU',1,'Unusual non-overlapping service'), ('LT',1,'Left side'), ('RT',1,'Right side'), ('25',1,'Significant separate E/M');

create or replace table CORE.EDIT_PAIRS (column1_code string, column2_code string, bypass_modifiers string,
  primary key (column1_code, column2_code));

create or replace table CORE.PROVIDER_ORGS (
  org_id string primary key, org_name string not null, tin string not null, specialty string, state string,
  network_kind string not null, epay_enrolled boolean not null, pay_method string not null, em_outlier boolean);

create or replace table CORE.PROVIDERS (provider_id string primary key, npi string not null, provider_name string,
  org_id string not null references CORE.PROVIDER_ORGS(org_id), specialty string);

create or replace table CORE.BANK_ACCOUNTS (
  bank_account_id string primary key, org_id string not null, bank_name string, routing_last4 string,
  account_last4 string, bank_state string, effective_from date not null, effective_to date,
  change_source string, verified boolean not null, verified_at timestamp_ntz, verified_by string);

create or replace table CORE.CONTRACTS (
  contract_id string primary key, payer_id string not null, org_id string, contract_kind string not null,
  pct_of_base number(5,2) not null, timely_filing_days int, payment_days int,
  stop_loss_threshold number(18,2), stop_loss_pct number(5,2), doc_file string);

create or replace table CORE.CONTRACT_CARVEOUTS (
  contract_id string not null, code string not null, rate_type string not null, rate number(18,2), pct number(5,2),
  markup_pct number(5,2), cap_mult number(6,2), source_section string);

-- ---------------------------------------------------------------- source (holding) + landed claims
create or replace table RAW.CLAIMS_SOURCE (
  claim_id string primary key, sim_day int not null, release_minute int not null, payer_id string, provider_id string,
  org_id string, member_id string, claim_type string, frequency_code string, service_from date, service_to date,
  received_date date, billed_amt number(18,2));
create or replace table RAW.CLAIM_LINES_SOURCE (claim_id string, line_no int, code string, modifiers string, units int,
  billed_amt number(18,2));
create or replace table RAW.ATTACHMENTS_SOURCE (attachment_id string primary key, claim_id string, sim_day int,
  release_minute int, file_name string, true_doc_type string, scanned boolean);

create table if not exists RAW.CLAIMS (
  claim_id string primary key, payer_id string not null, provider_id string not null, org_id string not null,
  member_id string not null, claim_type string, frequency_code string, service_from date, service_to date,
  billed_amt number(18,2) not null, sim_day int, received_at timestamp_ntz not null,
  landed_at timestamp_ntz default current_timestamp());
create table if not exists RAW.CLAIM_LINES (claim_id string not null, line_no int not null, code string not null,
  modifiers array, units int not null, billed_amt number(18,2) not null, primary key (claim_id, line_no));
create table if not exists RAW.ATTACHMENTS (attachment_id string primary key, claim_id string not null,
  file_name string not null, received_at timestamp_ntz not null);

-- ---------------------------------------------------------------- ground truth (evals only; never read by pipeline/agents)
create or replace table OPS.GROUND_TRUTH (
  claim_id string primary key, scenario string, expected_route string, expected_exception_type string,
  expected_decision string, expected_allowed_amt number(18,2), expected_line_actions variant, key_evidence variant,
  notes string);
