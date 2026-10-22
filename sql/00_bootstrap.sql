-- 00_bootstrap.sql — account-level objects for Zelis Claim-to-Cash.
-- Run as ACCOUNTADMIN. Idempotent.
use role accountadmin;

create role if not exists ZELIS_C2C_ROLE comment = 'Owns Zelis Claim-to-Cash data, pipeline, agents and the application service';
grant role ZELIS_C2C_ROLE to role SYSADMIN;
grant role ZELIS_C2C_ROLE to user BEDDY;

create warehouse if not exists ZELIS_C2C_WH
  warehouse_size = 'XSMALL' auto_suspend = 60 auto_resume = true initially_suspended = true
  comment = 'Zelis Claim-to-Cash pipeline + app queries';
grant usage, operate, monitor on warehouse ZELIS_C2C_WH to role ZELIS_C2C_ROLE;

create database if not exists ZELIS_C2C comment = 'Zelis Claim-to-Cash (synthetic data only)';
grant ownership on database ZELIS_C2C to role ZELIS_C2C_ROLE copy current grants;

-- Cortex: AI functions, Search, Analyst, Agents
grant database role SNOWFLAKE.CORTEX_USER to role ZELIS_C2C_ROLE;
-- AI Gateway: USAGE (send requests) + MONITOR (read AGENT_TRACE_TABLE for the governance page)
grant usage, monitor on ai gateway SNOWFLAKE to role ZELIS_C2C_ROLE;
-- Account usage views for lagged cost reconciliation
grant database role SNOWFLAKE.USAGE_VIEWER to role ZELIS_C2C_ROLE;

-- Serverless tasks / task execution
grant execute task, execute managed task on account to role ZELIS_C2C_ROLE;
-- Cortex Agents objects live in the data DB; agent creation needs CREATE AGENT on schema (granted by owner role below).

use role ZELIS_C2C_ROLE;
use warehouse ZELIS_C2C_WH;
create schema if not exists ZELIS_C2C.RAW  comment = 'Landed claims + intake stage';
create schema if not exists ZELIS_C2C.CORE comment = 'Reference data, pricing, integrity, payments';
create schema if not exists ZELIS_C2C.AI   comment = 'Document extracts, search services, agents, proposals';
create schema if not exists ZELIS_C2C.OPS  comment = 'Audit log, AI telemetry, evals, ground truth';
create schema if not exists ZELIS_C2C.APP  comment = 'Application service, semantic view, app-facing views';
