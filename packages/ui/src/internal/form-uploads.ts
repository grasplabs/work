// The uploads a form's file fields have under way. A form doesn't submit
// while one runs: it would save without the file, and the upload would
// then land in a form that had moved on.

interface Uploads {
  count: number;
  readonly listeners: Set<() => void>;
}

const byForm = new WeakMap<object, Uploads>();

const uploadsOf = (form: object): Uploads => {
  let uploads = byForm.get(form);
  if (uploads === undefined) {
    uploads = { count: 0, listeners: new Set() };
    byForm.set(form, uploads);
  }
  return uploads;
};

const tell = (uploads: Uploads): void => {
  for (const listener of uploads.listeners) {
    listener();
  }
};

/** An upload of `form`'s started: answers how to say it ended, once. */
export const uploadStarted = (form: object): (() => void) => {
  const uploads = uploadsOf(form);
  uploads.count += 1;
  tell(uploads);
  let ended = false;
  return () => {
    if (!ended) {
      ended = true;
      uploads.count -= 1;
      tell(uploads);
    }
  };
};

/** Whether `form` has an upload under way. */
export const isUploading = (form: object): boolean => uploadsOf(form).count > 0;

/** Tells `onChange` whenever an upload of `form`'s starts or ends. */
export const subscribeUploads = (
  form: object,
  onChange: () => void
): (() => void) => {
  const { listeners } = uploadsOf(form);
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};
