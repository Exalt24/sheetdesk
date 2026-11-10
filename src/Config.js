/**
 * Shared constants for every module. Apps Script loads all files into one
 * global scope, so this file is listed first in the clasp push order.
 */
const SD = {
  SHEETS: {
    CAMPAIGNS: 'Campaigns',
    CLIENTS: 'Clients',
    LEADS: 'Leads',
    RATES: 'Rates',
    CLEAN: 'Clean',
    ROLLUP: 'Rollup',
    REPORT_LOG: 'Report Log',
    JOB_LOG: 'Job Log',
    SUMMARY_PREFIX: 'Summary - '
  },
  HEADERS: {
    CAMPAIGNS: ['client', 'channel', 'date', 'spend', 'clicks', 'conversions', 'currency'],
    CLIENTS: ['client', 'contact_name', 'contact_email', 'ad_account_id', 'primary_channel',
      'monthly_budget', 'status', 'intake_response_id', 'created_at'],
    LEADS: ['lead_id', 'received_at', 'client', 'name', 'email', 'phone', 'source', 'campaign', 'message'],
    RATES: ['date', 'currency', 'per_usd'],
    CLEAN: ['source_row', 'client', 'channel', 'month', 'date', 'spend_usd', 'clicks', 'conversions', 'status'],
    ROLLUP: ['client', 'month', 'spend_usd', 'clicks', 'conversions', 'rows'],
    REPORT_LOG: ['client', 'month', 'pdf_name', 'pdf_id', 'figures', 'emailed_at', 'updated_at'],
    JOB_LOG: ['job', 'run', 'started_at', 'ended_at', 'rows_done', 'note']
  },
  PROPS: {
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    WEBHOOK_SECRET: 'WEBHOOK_SECRET',
    REPORT_FOLDER_ID: 'REPORT_FOLDER_ID',
    REPORT_TEMPLATE_ID: 'REPORT_TEMPLATE_ID',
    REPORT_CC: 'REPORT_CC',
    INTAKE_FORM_ID: 'INTAKE_FORM_ID',
    AD_API_BASE: 'AD_API_BASE',
    AD_API_KEY: 'AD_API_KEY',
    BULK_CURSOR: 'BULK_CURSOR'
  },
  AGENCY_NAME: 'Fernwood Digital',
  AD_API_DEFAULT_BASE: 'https://ads.example.test',
  FRANKFURTER_BASE: 'https://api.frankfurter.dev/v2/rates',
  MAX_EXEC_MS: 6 * 60 * 1000,
  BUDGET_MS: 4.5 * 60 * 1000,
  CHUNK_ROWS: 5000,
  CONTINUE_AFTER_MS: 60 * 1000,
  SAFETY_NET_MS: 7 * 60 * 1000,
  CACHE_CLIENTS_KEY: 'sd:clients',
  CACHE_CLIENTS_SECONDS: 300,
  INTAKE_TITLES: {
    CLIENT: 'Client name',
    CONTACT: 'Contact name',
    EMAIL: 'Contact email',
    CHANNEL: 'Primary channel',
    BUDGET: 'Monthly budget (USD)',
    NOTES: 'Notes'
  }
};
