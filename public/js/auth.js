const AUTH = {
  async me() {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const payload = await response.json();
    if (!response.ok || !payload.success) return null;
    return payload.data.user;
  },

  async requireAuth() {
    const user = await this.me();
    if (!user) {
      const nextPath = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login.html?next=${nextPath}`;
      return null;
    }
    return user;
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login.html';
  },

  apiFetch(url, options = {}) {
    return fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  },
};

window.AUTH = AUTH;
