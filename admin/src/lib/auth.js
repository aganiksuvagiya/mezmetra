// The only place that knows where the session token lives.
const KEY = 'mezmitra_admin_token';
// While the platform owner is "logged in as" a restaurant, their own token waits here so they can go back with one click.
const OWNER_KEY = 'mezmitra_owner_token_backup';

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

export const auth = {
  getToken: () => read(KEY),
  setToken: (token) => write(KEY, token),
  /** Signing out also forgets a waiting owner session: nobody is left half signed in. */
  clear() {
    remove(KEY);
    remove(OWNER_KEY);
  },
  hasOwnerBackup: () => Boolean(read(OWNER_KEY)),
  /** Put the owner's own session aside and become the restaurant (a one-hour token from the API). */
  startLoginAs(restaurantToken) {
    const own = read(KEY);
    if (own) write(OWNER_KEY, own);
    write(KEY, restaurantToken);
  },
  /** Back to the owner: the restaurant's token is dropped and the owner's own comes back. False when there was nothing to restore. */
  returnToOwner() {
    const own = read(OWNER_KEY);
    remove(OWNER_KEY);
    if (!own) return false;
    write(KEY, own);
    return true;
  },
  forgetOwnerBackup: () => remove(OWNER_KEY),
};
