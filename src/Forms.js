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
 * Validates one intake answer set.
 * @param {Object} a title -> answer
 * @return {{ok: boolean, problems: string[], client: string, contact: string, email: string,
 *   channel: string, budget: number}}
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
    const n = parseNumber_(budgetText.replace(/,/g, ''));
    if (n === null || n < 0) problems.push('monthly budget');
    else budget = n;
  }
  return {
    ok: problems.length === 0,
    problems: problems,
    client: client,
    contact: String(a[T.CONTACT] || '').trim().slice(0, 120),
    email: email,
    channel: String(a[T.CHANNEL] || '').trim().slice(0, 40),
    budget: budget
  };
}

/**
 * Installable trigger handler. Writes the response to Clients once (the
 * response id is the key) and emails a confirmation. A response that fails
 * validation or repeats an existing client name is stored with the status
 * needs_review and no email is sent.
 * @param {{response: GoogleAppsScript.Forms.FormResponse}} e
 * @return {{status: string, client: string, emailed: boolean}}
 */
function onIntakeSubmit(e) {
  if (!e || !e.response) throw new Error('onIntakeSubmit needs a form response event.');
  const responseId = e.response.getId();
  const parsed = checkIntake_(intakeAnswers_(e.response));
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let status;
  try {
    const ss = spreadsheet_();
    const sheet = getOrCreateSheet_(ss, SD.SHEETS.CLIENTS, SD.HEADERS.CLIENTS);
    const rows = readRows_(sheet, SD.HEADERS.CLIENTS.length);
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][7]) === responseId) return { status: 'duplicate', client: String(rows[i][0]), emailed: false };
    }
    const nameTaken = rows.some(function (r) {
      return String(r[0]).trim().toLowerCase() === parsed.client.toLowerCase();
    });
    status = parsed.ok && !nameTaken ? 'active' : 'needs_review';
    sheet.appendRow([
      sheetText_(parsed.client),
      sheetText_(parsed.contact),
      sheetText_(parsed.email),
      '',
      sheetText_(parsed.channel),
      parsed.budget,
      status,
      sheetText_(responseId),
      new Date()
    ]);
    SpreadsheetApp.flush();
    invalidateClientCache_();
  } finally {
    releaseLock_(lock);
  }
  let emailed = false;
  if (status === 'active') {
    try {
      GmailApp.sendEmail(
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
  return { status: status, client: parsed.client, emailed: emailed };
}
