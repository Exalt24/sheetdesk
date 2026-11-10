/**
 * Shared constants for every module. Apps Script loads all files into one
 * global scope, so this file must come first. .clasp.json lists Config.js and
 * Util.js in filePushOrder for that reason.
 *
 * Script properties (Project settings, Script properties) are named in
 * SD.PROPS and explained in SD.PROP_NOTES. Change AGENCY_NAME below to rename
 * the agency in emails, report folders and the dashboard.
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
  // Two columns the intake form fills after created_at. They are not required: a Clients tab without them
  // still works, and the intake form or Set up adds them when the two cells are blank.
  CLIENT_EXTRA_HEADERS: ['notes', 'review_reason'],
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
  PROP_NOTES: {
    SPREADSHEET_ID: 'Only for a script that is not bound to the Sheet: the id of the spreadsheet to work on.',
    WEBHOOK_SECRET: 'Made by Set up. Zapier or Make sends it in the body as "secret". Replace the value to rotate it.',
    REPORT_FOLDER_ID: 'Made on the first report. The Drive folder that holds the report PDFs.',
    REPORT_TEMPLATE_ID: 'Made on the first report. The template Doc. Edit that Doc to change the report layout.',
    REPORT_CC: 'Optional, one address. It is copied on every email to a client, and it receives "Send to me first" previews when Google gives no address for the person running the script.',
    INTAKE_FORM_ID: 'Made by installIntakeTrigger. The client intake form.',
    AD_API_BASE: 'Optional. The base URL of the ad platform API. Without it the stand-in host https://ads.example.test is used, which exists only in the tests.',
    AD_API_KEY: 'Needed to pull ad costs. Sent as a Bearer token.',
    BULK_CURSOR: 'Internal. Where the bulk job stands. Do not edit it.'
  },
  AGENCY_NAME: 'Fernwood Digital',
  AD_API_DEFAULT_BASE: 'https://ads.example.test',
  FRANKFURTER_BASE: 'https://api.frankfurter.dev/v2/rates',
  MAX_EXEC_MS: 6 * 60 * 1000,
  BUDGET_MS: 4.5 * 60 * 1000,
  CHUNK_ROWS: 5000,
  RATE_PULL_MAX_DAYS: 1096,
  RATE_PULL_PIECE_DAYS: 92,
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
