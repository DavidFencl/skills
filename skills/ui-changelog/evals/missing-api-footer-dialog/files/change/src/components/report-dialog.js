// @ts-check
import { createSupportReport } from '../api.js';
import { el } from './dom.js';

const MIN_LENGTH = 10;

/** Opens the "Report a problem" dialog: form, validation, sending, sent and error states. */
export function openReportDialog() {
  const description = /** @type {HTMLTextAreaElement} */ (el('textarea', { id: 'report-description', rows: '5', placeholder: 'What went wrong? What did you expect to happen?' }));
  const email = /** @type {HTMLInputElement} */ (el('input', { id: 'report-email', type: 'email', placeholder: 'you@example.com' }));
  const message = el('p', { class: 'report-dialog__message', role: 'status' });
  const submit = /** @type {HTMLButtonElement} */ (el('button', { class: 'button', type: 'submit', 'data-testid': 'report-submit' }, 'Send report'));
  const cancel = el('button', { class: 'button button--ghost', type: 'button' }, 'Cancel');
  const form = el(
    'form',
    { class: 'report-dialog__form', novalidate: '' },
    el('label', { for: 'report-description' }, 'Describe the problem'),
    description,
    el('label', { for: 'report-email' }, 'Email for follow-up (optional)'),
    email,
    message,
    el('div', { class: 'report-dialog__actions' }, cancel, submit),
  );
  const dialog = /** @type {HTMLDialogElement} */ (
    el('dialog', { class: 'report-dialog', 'aria-labelledby': 'report-title' }, el('h2', { id: 'report-title' }, 'Report a problem'), el('p', { class: 'report-dialog__intro' }, 'Tell us what happened. We read every report.'), form)
  );

  cancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => dialog.remove());
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (description.value.trim().length < MIN_LENGTH) {
      message.className = 'report-dialog__message report-dialog__message--error';
      message.textContent = `Please describe the problem in at least ${MIN_LENGTH} characters.`;
      description.setAttribute('aria-invalid', 'true');
      return;
    }
    description.removeAttribute('aria-invalid');
    submit.disabled = true;
    submit.textContent = 'Sending…';
    message.className = 'report-dialog__message';
    message.textContent = '';
    try {
      const receipt = await createSupportReport({ description: description.value.trim(), email: email.value.trim() || undefined, page: location.pathname });
      form.replaceWith(
        el(
          'div',
          { class: 'report-dialog__sent', 'data-testid': 'report-sent' },
          el('p', {}, 'Thanks! Your report reached our volunteers.'),
          el('p', { class: 'report-dialog__reference' }, `Reference ${receipt.reportId}`),
          closeButton(dialog),
        ),
      );
    } catch {
      submit.disabled = false;
      submit.textContent = 'Try again';
      message.className = 'report-dialog__message report-dialog__message--error';
      message.textContent = 'We could not send your report right now. Please try again in a few minutes.';
    }
  });

  document.body.append(dialog);
  dialog.showModal();
  description.focus();
  return dialog;
}

/** @param {HTMLDialogElement} dialog */
function closeButton(dialog) {
  const button = el('button', { class: 'button', type: 'button' }, 'Close');
  button.addEventListener('click', () => dialog.close());
  return button;
}
