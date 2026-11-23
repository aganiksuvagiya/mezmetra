// The only place that knows where the session token lives.
const KEY = 'mezmitra_admin_token';

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode): the session just will not survive a reload */
  }
};
const remove = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
};

// The owner console used to keep the owner's own token aside here while it "logged in as" a restaurant. That feature is gone, so a
// token left behind by it must not stay in the browser.
remove('mezmitra_owner_token_backup');

export const auth = {
  getToken: () => read(KEY),
  setToken: (token) => write(KEY, token),
  clear: () => remove(KEY),
};
