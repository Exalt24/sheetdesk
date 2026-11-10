/**
 * Client intake: a Google Form, an installable onFormSubmit trigger, a row in
 * the Clients sheet and a confirmation email.
 *
 * A simple onFormSubmit(e) function cannot send email or touch Drive, so the
 * handler is installed as a trigger by installIntakeTrigger().
 */

/**
 * Creates the intake form with one item per field. Idempotent: reuses the form
 * saved in the INTAKE_FORM_ID script property when it still opens.
 * @return {GoogleAppsScript.Forms.Form}
 */
function ensureIntakeForm_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(SD.PROPS.INTAKE_FORM_ID);
  if (id) {
    try {
      return FormApp.openById(id);
    } catch (err) {
      // the saved form was deleted: make a new one below
    }
  }
  const T = SD.INTAKE_TITLES;
  const form = FormApp.create(SD.AGENCY_NAME + ' client intake');
  form.setDescription('Tell us who you are and where to send reports.');
  form.addTextItem().setTitle(T.CLIENT).setRequired(true);
  form.addTextItem().setTitle(T.CONTACT).setRequired(true);
  form.addTextItem().setTitle(T.EMAIL).setRequired(true);
  form.addMultipleChoiceItem().setTitle(T.CHANNEL).setChoiceValues(['search', 'social', 'display', 'email', 'video']).setRequired(true);
  form.addTextItem().setTitle(T.BUDGET).setRequired(false);
  form.addParagraphTextItem().setTitle(T.NOTES).setRequired(false);
  props.setProperty(SD.PROPS.INTAKE_FORM_ID, form.getId());
  return form;
}

/**
 * Installs the form submit trigger. Run it once from the editor after
 * authorising the script. Running it again replaces the trigger, so there is
 * never more than one.
 * @return {{formId: string, url: string, triggerId: string}}
 */
function installIntakeTrigger() {
  const form = ensureIntakeForm_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onIntakeSubmit') ScriptApp.deleteTrigger(t);
  });
  const trigger = ScriptApp.newTrigger('onIntakeSubmit').forForm(form).onFormSubmit().create();
  // Run from the editor, the return value is not shown anywhere, so the link goes to the execution log.
  Logger.log('Intake form link: ' + form.getPublishedUrl());
  return { formId: form.getId(), url: form.getPublishedUrl(), triggerId: trigger.getUniqueId() };
}

/**
 * Turns the item responses into a title -> answer map.
 * @param {GoogleAppsScript.Forms.FormResponse} response
 * @return {Object}
 */
function intakeAnswers_(response) {
  const out = {};
  response.getItemResponses().forEach(function (ir) {
    const a = ir.getResponse();
    out[ir.getItem().getTitle()] = Array.isArray(a) ? a.join(', ') : String(a === null || a === undefined ? '' : a);
  });
  return out;
}

/**
 * Reads a monthly budget as people write it: 2500, 2,500, $2,500, USD 2,500,
 * 2500 USD, 2.5k, $2.5K. Any commas are dropped, as before.
 * @param {string} text
 * @return {?number} the amount in dollars, or null when it is not a number of zero or more
 */
function parseBudget_(text) {
  let t = String(text).trim().toLowerCase().replace(/,/g, '');
  t = t.replace(/^(us\$|usd|\$)\s*/, '').replace(/\s*usd$/, '');
  const k = /^(.*?)\s*k$/.exec(t);
  const n = parseNumber_(k ? k[1] : t);
  if (n === null || n < 0) return null;
  return k ? Math.round(n * 1000 * 100) / 100 : n;
}

/**
 * Validates one intake answer set.
 * @param {Object} a title -> answer
 * @return {{ok: boolean, problems: string[], client: string, contact: string, email: string,
 *   channel: string, budget: number, notes: string}}
 */
function checkIntake_(a) {
  const T = SD.INTAKE_TITLES;
  const problems = [];
  const client = String(a[T.CLIENT] || '').trim();
  const email = String(a[T.EMAIL] || '').trim();
  const budgetText = String(a[T.BUDGET] || '').trim();
  if (!client || client.length > 120) problems.push('client name');
  if (!isEmail_(email)) problems.push('contact email');
  let budget = 0;
  if (budgetText) {
    const n = parseBudget_(budgetText);
    if (n === null) problems.push('monthly budget');
    else budget = n;
  }
  return {
    ok: problems.length === 0,
    problems: problems,
    client: client,
    contact: String(a[T.CONTACT] || '').trim().slice(0, 120),
    email: email,
    channel: String(a[T.CHANNEL] || '').trim().slice(0, 40),
    budget: budget,
    notes: String(a[T.NOTES] || '').trim().slice(0, 50000)
  };
}

/**
 * Installable trigger handler. Writes the response to Clients once (the
 * response id is the key) and emails a confirmation. A response that fails
 * validation, or whose client name would share a report file name or a summary
 * tab with an active client, is stored with the status needs_review and no
 * email is sent, and the review_reason cell says which check failed. A parked
 * row (needs_review) is not a client: it never holds a new name back. The Notes
 * answer is kept in the notes column.
 * @param {{response: GoogleAppsScript.Forms.FormResponse}} e
 * @return {{status: string, client: string, emailed: boolean, reason: (string|undefined)}}
 */
function onIntakeSubmit(e) {
  if (!e || !e.response) throw new Error('onIntakeSubmit needs a form response event.');
  const responseId = e.response.getId();
  const parsed = checkIntake_(intakeAnswers_(e.response));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let status;
  let reason;
  try {
    const ss = spreadsheet_();
    const sheet = getOrCreateSheet_(ss, SD.SHEETS.CLIENTS, SD.HEADERS.CLIENTS);
    const rows = readRows_(sheet, SD.HEADERS.CLIENTS.length);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][7]) === responseId) return { status: 'duplicate', client: String(rows[i][0]), emailed: false };
    }
    // A name that would share a PDF file name or a summary tab with an active client (other case, a trailing
    // period, other spacing) is held for review: the reports refuse both names, so it must not be confirmed.
    // Only active rows count: a parked row is not a client and never holds a new name back.
    const taken = rows.filter(function (r) {
      return String(r[6]).trim().toLowerCase() === 'active' && String(r[0]).trim() !== '' && namesClash_(String(r[0]).trim(), parsed.client);
    })[0];
    status = parsed.ok && !taken ? 'active' : 'needs_review';
    const why = [];
    if (!parsed.ok) why.push('Check failed: ' + parsed.problems.join(', ') + '.');
    if (taken) why.push('The name would share a report file name or summary tab with the active client "' + String(taken[0]).trim() + '".');
    reason = why.join(' ');
    const row = [
      sheetText_(parsed.client),
      sheetText_(parsed.contact),
      sheetText_(parsed.email),
      '',
      sheetText_(parsed.channel),
      parsed.budget,
      status,
      sheetText_(responseId),
      new Date()
    ];
    // The notes and the reason follow created_at. When a column of the tab's own sits there, the row keeps its nine columns.
    if (ensureClientExtras_(sheet)) row.push(sheetText_(parsed.notes), sheetText_(reason));
    else Logger.log('The Clients tab has its own text in J1 or K1, so the notes and the review reason of response ' + responseId + ' were not kept.');
    sheet.appendRow(row);
    SpreadsheetApp.flush();
    invalidateClientCache_();
  } finally {
    releaseLock_(lock);
  }
  let emailed = false;
  if (status === 'active') {
    try {
      MailApp.sendEmail(
        parsed.email,
        'We received your details, ' + parsed.client,
        'Hello ' + (parsed.contact || 'there') + ',\n\nWe added ' + parsed.client + ' to our client list. ' +
        'Your first report goes to this address.\n\n' + SD.AGENCY_NAME,
        { name: SD.AGENCY_NAME }
      );
      emailed = true;
    } catch (err) {
      Logger.log('Confirmation email failed for response ' + responseId + ': ' + err.message);
    }
  }
  const out = { status: status, client: parsed.client, emailed: emailed };
  if (reason) out.reason = reason;
  return out;
}
